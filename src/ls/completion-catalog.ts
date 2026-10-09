import { promises as fs } from 'fs';
import path from 'path';

export interface CatalogItem {
  label: string;
  schema: string;
  database: string;
  type: string;
  detail: string;
  isView?: boolean;
}

const REFRESH_INTERVAL = 15 * 60 * 1000;
const RETRY_INTERVAL = 60 * 1000;
export const CATALOG_CONCURRENCY = 8;

export class CompletionCatalog {
  datasets: CatalogItem[] = [];
  tables = new Map<string, CatalogItem[]>();
  private initialized?: Promise<void>;
  private restored?: Promise<boolean>;
  private loading = new Map<string, Promise<CatalogItem[]>>();
  private refreshing?: Promise<void>;
  private refreshedAt = 0;
  private retryAt = 0;
  private generation = 0;
  private active = 0;
  private waiters: (() => void)[] = [];

  constructor(
    private project: string,
    private loadDatasets: () => Promise<CatalogItem[]>,
    private loadTables: (dataset: string) => Promise<CatalogItem[]>,
    private report: (message: string) => void,
    private filename?: string,
  ) {}

  async initialize(): Promise<void> {
    if (!this.initialized) {
      const generation = this.generation;
      this.initialized = this.restore().then(async stored => {
        if (generation !== this.generation) return;
        if (stored) return;
        const datasets = await this.loadDatasets();
        if (generation === this.generation) this.datasets = datasets;
      }).catch(error => {
        if (generation === this.generation) this.initialized = undefined;
        throw error;
      });
    }
    await this.initialized;
  }

  private restore(): Promise<boolean> {
    if (!this.restored) this.restored = this.read(this.generation);
    return this.restored;
  }

  private async limited<T>(load: () => Promise<T>): Promise<T> {
    if (this.active >= CATALOG_CONCURRENCY) await new Promise<void>(resolve => this.waiters.push(resolve));
    else this.active++;
    try {
      return await load();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }

  async datasetTables(dataset: string): Promise<CatalogItem[]> {
    const generation = this.generation;
    await this.restore();
    if (generation !== this.generation) return [];
    const cached = this.tables.get(dataset);
    if (cached) return cached;
    return this.fetchTables(dataset);
  }

  private fetchTables(dataset: string): Promise<CatalogItem[]> {
    const existing = this.loading.get(dataset);
    if (existing) return existing;
    const generation = this.generation;
    const pending = this.limited(async () => {
      if (generation !== this.generation) return [];
      const items = await this.loadTables(dataset);
      if (generation === this.generation) this.tables.set(dataset, items);
      return items;
    }).finally(() => {
      if (this.loading.get(dataset) === pending) this.loading.delete(dataset);
    });
    this.loading.set(dataset, pending);
    return pending;
  }

  startRefresh(): boolean {
    if (!this.refreshing && Date.now() >= this.retryAt &&
      Date.now() - this.refreshedAt >= REFRESH_INTERVAL) {
      void this.refresh().catch(error => this.report(`BigQuery catalog refresh failed: ${error.message || error}`));
    }
    return !!this.refreshing || !this.refreshedAt;
  }

  async ready(): Promise<void> {
    await this.initialize();
    this.startRefresh();
    await this.refreshing;
  }

  refresh(force = false): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const generation = this.generation;
    const pending = (async () => {
      await this.initialize();
      if (generation !== this.generation) return;
      if (force || this.refreshedAt) {
        const datasets = await this.loadDatasets();
        if (generation !== this.generation) return;
        this.datasets = datasets;
      }
      let index = 0;
      let failed = false;
      const datasets = this.datasets;
      await Promise.all(Array.from({ length: Math.min(CATALOG_CONCURRENCY, datasets.length) }, async () => {
        while (index < datasets.length && generation === this.generation) {
          const dataset = datasets[index++];
          try {
            if (force || this.refreshedAt) await this.fetchTables(dataset.schema);
            else await this.datasetTables(dataset.schema);
          } catch (error) {
            failed = true;
            this.report(`BigQuery catalog lookup failed for ${this.project}.${dataset.schema}: ${error.message || error}`);
          }
        }
      }));
      if (generation !== this.generation) return;
      if (failed) {
        this.retryAt = Date.now() + RETRY_INTERVAL;
        throw new Error('Some dataset table lists could not be refreshed; retaining available metadata.');
      }
      const names = new Set(datasets.map(dataset => dataset.schema));
      for (const name of this.tables.keys()) if (!names.has(name)) this.tables.delete(name);
      this.refreshedAt = Date.now();
      this.retryAt = 0;
      await this.write();
    })().finally(() => {
      if (this.refreshing === pending) this.refreshing = undefined;
    });
    this.refreshing = pending;
    return pending;
  }

  close(): void {
    this.generation++;
    this.datasets = [];
    this.tables.clear();
    this.loading.clear();
    this.initialized = undefined;
    this.restored = undefined;
    this.refreshedAt = 0;
    this.refreshing = undefined;
    this.retryAt = 0;
  }

  private async read(generation: number): Promise<boolean> {
    if (!this.filename) return false;
    try {
      const stored = JSON.parse(await fs.readFile(this.filename, 'utf8'));
      const validItem = (item: CatalogItem) => item && typeof item.label === 'string' &&
        typeof item.schema === 'string' && item.database === this.project &&
        typeof item.type === 'string' && typeof item.detail === 'string' &&
        (item.isView === undefined || typeof item.isView === 'boolean');
      if (stored.version !== 1 || stored.project !== this.project ||
        typeof stored.refreshedAt !== 'number' || !Array.isArray(stored.datasets) ||
        !stored.datasets.every(validItem) || !Array.isArray(stored.tables) ||
        !stored.tables.every(entry => Array.isArray(entry) && typeof entry[0] === 'string' &&
          Array.isArray(entry[1]) && entry[1].every(validItem))) {
        throw new Error('Invalid BigQuery completion catalog snapshot.');
      }
      if (generation !== this.generation) return false;
      this.datasets = stored.datasets;
      this.tables = new Map(stored.tables);
      this.refreshedAt = stored.refreshedAt;
      return true;
    } catch (error) {
      if (error.code !== 'ENOENT') this.report(`Unable to read BigQuery completion catalog: ${error.message || error}`);
      return false;
    }
  }

  private async write(): Promise<void> {
    if (!this.filename) return;
    const temporary = `${this.filename}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.mkdir(path.dirname(this.filename), { recursive: true });
      await fs.writeFile(temporary, JSON.stringify({
        version: 1, project: this.project, refreshedAt: this.refreshedAt,
        datasets: this.datasets, tables: [...this.tables],
      }), { mode: 0o600 });
      await fs.rename(temporary, this.filename);
    } catch (error) {
      this.report(`Unable to persist BigQuery completion catalog: ${error.message || error}`);
      try { await fs.unlink(temporary); } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') this.report(`Unable to remove temporary catalog: ${cleanupError.message}`);
      }
    }
  }
}
