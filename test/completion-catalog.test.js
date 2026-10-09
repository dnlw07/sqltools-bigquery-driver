const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { CompletionCatalog, CATALOG_CONCURRENCY } = require('../out/ls/completion-catalog');
const BigQueryDriver = require('../out/ls/driver').default;

const row = (schema, label = schema) => ({
  label, schema, database: 'test-project', type: 'connection.table', detail: 'Table', isView: false,
});
const tick = () => new Promise(resolve => setImmediate(resolve));

test('500 datasets and 23,000 tables load with bounded concurrency and no cache churn', async () => {
  const driver = new BigQueryDriver({
    id: 'scale', name: 'scale', driver: 'BigQuery', projectId: 'test-project',
  }, async () => []);
  let calls = 0;
  let active = 0;
  let peak = 0;
  driver.open = async () => ({
    getDatasets: async () => [[...Array(500)].map((_, i) => ({ id: `dataset_${String(i).padStart(3, '0')}` }))],
    dataset: schema => ({
      getTables: async () => {
        calls++;
        peak = Math.max(peak, ++active);
        await tick();
        active--;
        return [Array.from({ length: 46 }, (_, i) => ({
          id: `${schema}_table_${i}`, metadata: { type: 'TABLE' },
        }))];
      },
    }),
  });
  const sql = 'SELECT * FROM ';
  const first = await driver.getCompletionsForRawQuery(sql, sql.length);
  assert.equal(first.items.length, 500);
  assert.equal(first.isIncomplete, true);
  assert.ok(first.items.every(item => item.detail === 'Dataset'));
  const catalog = driver.completionCatalogs.get('test-project');
  await catalog.ready();
  assert.equal(calls, 500);
  assert.ok(peak <= CATALOG_CONCURRENCY, `peak requests: ${peak}`);
  assert.equal([...catalog.tables.values()].reduce((total, tables) => total + tables.length, 0), 23000);
  const started = performance.now();
  for (let i = 0; i < 20; i++) {
    const query = 'SELECT * FROM dataset_499table_45';
    const result = await driver.getCompletionsForRawQuery(query, query.length);
    assert.ok(result.items.some(item => item.label === 'dataset_499_table_45'));
    assert.ok(result.items.length < 500);
    assert.equal(result.isIncomplete, false);
  }
  assert.equal(calls, 500);
  const elapsed = performance.now() - started;
  console.log(`23k-table benchmark: 20 cached searches in ${elapsed.toFixed(1)}ms; peak ${peak} API calls.`);
  assert.ok(elapsed < 5000, '20 cached catalog searches must complete within 5 seconds');
  await driver.close();
});

test('cold completion returns datasets without waiting for a blocked table API', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const catalog = new CompletionCatalog('test-project', async () => [row('hr')],
    async () => { await blocked; return [row('hr', 'employee')]; }, assert.fail);
  await catalog.initialize();
  assert.equal(catalog.startRefresh(), true);
  assert.equal(catalog.datasets.length, 1);
  assert.equal(catalog.tables.size, 0);
  release();
  await catalog.ready();
  assert.equal(catalog.startRefresh(), false);
});

test('targeted table lookup shares in-flight requests with background warming', async () => {
  let calls = 0;
  const catalog = new CompletionCatalog('test-project', async () => [row('hr')],
    async () => { calls++; await tick(); return [row('hr', 'employee')]; }, assert.fail);
  await catalog.initialize();
  catalog.startRefresh();
  const [left, right] = await Promise.all([catalog.datasetTables('hr'), catalog.datasetTables('hr')]);
  await catalog.ready();
  assert.equal(calls, 1);
  assert.deepEqual(left, right);
});

test('persists compact metadata and restores it without API calls; forced refresh replaces deleted objects', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bigquery-catalog-test-'));
  const filename = path.join(directory, 'catalog.json');
  try {
    const catalog = new CompletionCatalog('test-project', async () => [row('hr')],
      async () => [row('hr', 'old')], assert.fail, filename);
    await catalog.ready();
    const stored = JSON.parse(await fs.readFile(filename, 'utf8'));
    assert.equal(stored.tables[0][1][0].label, 'old');
    assert.equal(stored.tables[0][1][0].metadata, undefined);
    let calls = 0;
    const restored = new CompletionCatalog('test-project', async () => { calls++; return [row('new')]; },
      async schema => { calls++; return [row(schema, 'fresh')]; }, assert.fail, filename);
    assert.equal((await restored.datasetTables('hr'))[0].label, 'old');
    assert.equal(calls, 0);
    await restored.initialize();
    assert.equal(calls, 0);
    assert.equal(restored.startRefresh(), false);
    assert.equal((await restored.datasetTables('hr'))[0].label, 'old');
    await restored.refresh(true);
    assert.equal(calls, 2);
    assert.equal(restored.tables.has('hr'), false);
    assert.equal(restored.tables.get('new')[0].label, 'fresh');
  } finally {
    await fs.rm(directory, { recursive: true });
  }
});

test('invalid snapshots report errors and fall back to API metadata', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bigquery-catalog-invalid-'));
  const filename = path.join(directory, 'catalog.json');
  try {
    await fs.writeFile(filename, '{"version":99}');
    const errors = [];
    const catalog = new CompletionCatalog('test-project', async () => [row('hr')],
      async () => [], error => errors.push(error), filename);
    await catalog.initialize();
    assert.equal(catalog.datasets[0].label, 'hr');
    assert.match(errors[0], /Invalid BigQuery completion catalog snapshot/);
  } finally {
    await fs.rm(directory, { recursive: true });
  }
});

test('closed catalogs do not accept late background table responses', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const catalog = new CompletionCatalog('test-project', async () => [row('hr')],
    async () => { await blocked; return [row('hr', 'employee')]; }, assert.fail);
  await catalog.initialize();
  const pending = catalog.refresh();
  await tick();
  catalog.close();
  release();
  await pending;
  assert.equal(catalog.tables.size, 0);
  assert.equal(catalog.datasets.length, 0);
});

test('stale snapshots are served while refreshed metadata loads in the background', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bigquery-catalog-stale-'));
  const filename = path.join(directory, 'catalog.json');
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  try {
    await fs.writeFile(filename, JSON.stringify({
      version: 1, project: 'test-project', refreshedAt: Date.now() - 16 * 60 * 1000,
      datasets: [row('hr')], tables: [['hr', [row('hr', 'old')]]],
    }));
    const catalog = new CompletionCatalog('test-project', async () => [row('hr')],
      async () => { await blocked; return [row('hr', 'new')]; }, assert.fail, filename);
    await catalog.initialize();
    assert.equal(catalog.startRefresh(), true);
    assert.equal(catalog.tables.get('hr')[0].label, 'old');
    release();
    await catalog.ready();
    assert.equal(catalog.tables.get('hr')[0].label, 'new');
  } finally {
    release();
    await fs.rm(directory, { recursive: true });
  }
});

test('failed background refresh retains available metadata and backs off retries', async () => {
  let calls = 0;
  const errors = [];
  const catalog = new CompletionCatalog('test-project', async () => [row('hr'), row('private')],
    async dataset => {
      calls++;
      if (dataset === 'private') throw new Error('access denied');
      return [row('hr', 'employee')];
    }, error => errors.push(error));
  await assert.rejects(catalog.refresh(), /Some dataset table lists/);
  assert.equal(catalog.tables.get('hr')[0].label, 'employee');
  catalog.startRefresh();
  await tick();
  assert.equal(calls, 2);
  assert.match(errors[0], /test-project.private.*access denied/);
});

test('persisted driver catalogs are separated by connection identity', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bigquery-catalog-connections-'));
  const previous = BigQueryDriver.completionStoragePath;
  const drivers = [];
  try {
    BigQueryDriver.completionStoragePath = directory;
    for (const id of ['first', 'second']) {
      const driver = new BigQueryDriver({
        id, name: id, driver: 'BigQuery', projectId: 'test-project',
      }, async () => []);
      drivers.push(driver);
      driver.open = async () => ({
        getDatasets: async () => [[{ id }]],
        dataset: () => ({ getTables: async () => [[{ id: `${id}_table`, metadata: { type: 'TABLE' } }]] }),
      });
      await driver.refreshCompletionMetadata();
    }
    const files = await fs.readdir(directory);
    assert.equal(files.length, 2);
    const payloads = await Promise.all(files.map(file => fs.readFile(path.join(directory, file), 'utf8')));
    assert.ok(payloads.some(payload => payload.includes('first_table')));
    assert.ok(payloads.some(payload => payload.includes('second_table')));
    assert.ok(payloads.every(payload => !payload.includes('credentials')));
  } finally {
    for (const driver of drivers) await driver.close();
    BigQueryDriver.completionStoragePath = previous;
    await fs.rm(directory, { recursive: true });
  }
});
