import AbstractDriver from '@sqltools/base-driver';
import { CompletionItem, CompletionItemKind } from 'vscode-languageserver';
import {
  IConnectionDriver,
  MConnectionExplorer,
  NSDatabase,
  ContextValue,
  Arg0,
} from "@sqltools/types";
import { v4 as generateId } from 'uuid';
import queries from './queries';
import { standardizeResult, formatDuration, matchesCompletionName }  from './utils';

type DriverLib = any;
type DriverOptions = any;

export interface IBigQueryResultEdit {
  table: { label: string; schema?: string };
  primaryKey: { [column: string]: any };
  changes: { [column: string]: any };
}

export interface IBigQueryResultEditResponse {
  success: boolean;
  error?: string;
  failedIndex?: number;
}

export default class BigQueryDriver extends AbstractDriver<DriverLib, DriverOptions> implements IConnectionDriver {
  public readonly deps: typeof AbstractDriver.prototype['deps'] = [
    {
      type: AbstractDriver.CONSTANTS.DEPENDENCY_PACKAGE,
      name: '@google-cloud/bigquery',
      version: '7.9.0'
    },
    {
      type: AbstractDriver.CONSTANTS.DEPENDENCY_PACKAGE,
      name: 'google-auth-library',
      version: '9.14.1'
    },
  ];

  queries: any = queries;

  private _sessionId?: string;
  private _paginationCache?: Map<string, { total: number; exact: boolean; resultId: string }>;
  private _bigqueryConnection: Promise<any> | null = null;
  private completionMetadataCache = new Map<string, Promise<any[]>>();
  private datasetMetadataCache = new Map<string, Promise<any[]>>();

  public async open() {
    if (this._bigqueryConnection) return this._bigqueryConnection;
    const BigQuery = this.requireDep('@google-cloud/bigquery').BigQuery;
    const OAuth2Client = this.requireDep('google-auth-library').OAuth2Client;
    const getCredentials = () => {


      const authentication_method = this.credentials.authenticator
      if (authentication_method === 'CLI') {
        return {
          projectId: this.credentials.projectId,
          location: this.credentials.location
        };
      } else if (authentication_method === 'OAUTH') {
        const access_token = this.credentials.token;
        const oauth = new OAuth2Client();
        oauth.setCredentials({ access_token });

        return {
          // is this a legit way to handle this typescript error
          authClient: oauth as any,
          projectId: this.credentials.projectId,
          location: this.credentials.location
        };
      } else {
        return {
          keyFilename: this.credentials.keyfile,
          location: this.credentials.location
        }
      };
    }

    let connOptions = getCredentials();

    const connection = new Promise<any>((resolve, reject) => {
      try {
        const bigquery = new BigQuery({ ...connOptions, maxRetries: 10 });
        resolve(bigquery);
      } catch (error) {
        reject(error);
      }
    });
    this._bigqueryConnection = connection;

    const initSql = this.credentials.connectionInitSql;
    if (initSql && !this._sessionId) {
      const bigquery = await connection;
      try {
        const [job] = await bigquery.createQueryJob({
          query: initSql,
          location: this.credentials.location,
          createSession: true,
        });
        await job.getQueryResults();
        const [metadata] = await job.getMetadata();
        const sessionId = metadata?.statistics?.sessionInfo?.sessionId;
        if (!sessionId) {
          throw new Error('BigQuery did not return a session id for the init session');
        }
        this._sessionId = sessionId;
      } catch (error) {
        this._bigqueryConnection = null;
        throw new Error('Connection init SQL failed: ' + (error instanceof Error ? error.message : String(error)));
      }
    }
    return connection;
  }


  public async close() {
    this.completionMetadataCache.clear();
    this.datasetMetadataCache.clear();
    if (!this._bigqueryConnection) return Promise.resolve();

    this._bigqueryConnection = null;
    this._sessionId = undefined;
    this._paginationCache = undefined;
  }

  public async testConnection() {
    try {
      const bigquery = await this.open();
      await bigquery.query('SELECT 1');
      await this.close();

    } catch (error) {
      throw new Error('Failed to connect to BigQuery: ' + (error instanceof Error ? error.message : String(error)));
    }
  }

  public singleQuery: (typeof AbstractDriver)['prototype']['singleQuery'] = ((query: any, opt: any) => {
    return this.query(query, { ...opt, __internal: true }).then(([res]) => res);
  }) as any;

  private _isPaginatableSelect(sql: string): boolean {
    if (this.credentials.disablePagination) return false;
    const withoutComments = sql.toString().replace(/^\s*(--[^\n]*\n)+/, '').trim();
    if (!/^(SELECT|WITH)\b/i.test(withoutComments)) return false;
    const withoutTrailingSemi = withoutComments.replace(/;\s*$/, '');
    // reject multiple statements
    return !/;\s*\S/.test(withoutTrailingSemi);
  }

  private _stripTrailingSemicolon(sql: string): string {
    return sql.toString().replace(/;\s*$/, '');
  }

  private _buildConnectionProperties() {
    if (this._sessionId) {
      return [{ key: 'session_id', value: this._sessionId }];
    }
    return undefined;
  }

  private async qualifyTable(table: NSDatabase.ITable): Promise<NSDatabase.ITable> {
    if (table.database) return table;
    const projectId = this.credentials.projectId || (await this.open()).projectId;
    if (!projectId) throw new Error('Unable to determine the BigQuery project for this table.');
    return { ...table, database: projectId };
  }

  public async describeTable(table: NSDatabase.ITable, opt: any) {
    return super.describeTable(await this.qualifyTable(table), opt);
  }

  public async showRecords(table: NSDatabase.ITable, opt: any) {
    return super.showRecords(await this.qualifyTable(table), opt);
  }

  // BigQuery's job/column metadata doesn't include the source table, so a single, unambiguous
  // FROM clause (optionally backtick-quoted, up to project.dataset.table) is required.
  private getSingleTableSource(sql: string): { schema: string; table: string } | null {
    const normalized = sql.replace(/\s+/g, ' ');
    if (/\bJOIN\b|\bUNION\b|\bINTERSECT\b|\bEXCEPT\b|\bFROM\s*\(/i.test(normalized)) return null;
    const match = normalized.match(/\bFROM\s+`?([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){1,2})`?(?:\s+(?:AS\s+)?[A-Za-z_][\w$]*)?(?:\s|;|$)/i);
    if (!match) return null;
    const parts = match[1].split('.');
    return { schema: parts[parts.length - 2], table: parts[parts.length - 1] };
  }

  private async resolveResultEditability(bigquery: any, cols: string[], sql: string, baseOptions: any) {
    if (!cols.length) return { editable: false, nonEditableReason: 'Result has no columns.' };
    const singleTable = this.getSingleTableSource(sql);
    if (!singleTable) return { editable: false, nonEditableReason: 'Result does not identify one physical BigQuery table.' };
    const { schema, table } = singleTable;

    let knownColumns: Set<string>;
    try {
      const [job] = await bigquery.createQueryJob({ ...baseOptions, query: `SELECT column_name FROM \`${schema}\`.INFORMATION_SCHEMA.COLUMNS WHERE table_name = @table`, params: { table } });
      const [rows] = await job.getQueryResults();
      knownColumns = new Set(rows.map((row: any) => String(row.column_name).toUpperCase()));
    } catch (error) {
      return { editable: false, nonEditableReason: 'Unable to resolve table metadata for this result.' };
    }
    if (!knownColumns.size) return { editable: false, nonEditableReason: 'Result columns cannot be mapped to the source BigQuery table.' };

    const resolvedSources = cols.map((name, index) => ({ index, sourceColumn: name, table, schema }));
    if (resolvedSources.some(source => !knownColumns.has(String(source.sourceColumn).toUpperCase()))) {
      return { editable: false, nonEditableReason: 'Result columns cannot be mapped to the source BigQuery table.' };
    }

    let primaryKeys: string[] = [];
    try {
      const [job] = await bigquery.createQueryJob({
        ...baseOptions,
        query: `SELECT kcu.column_name AS column_name
                FROM \`${schema}\`.INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
                JOIN \`${schema}\`.INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
                  ON tc.constraint_name = kcu.constraint_name
                WHERE tc.table_name = @table AND tc.constraint_type = 'PRIMARY KEY'`,
        params: { table },
      });
      const [rows] = await job.getQueryResults();
      primaryKeys = rows.map((row: any) => String(row.column_name).toUpperCase());
    } catch (error) {
      // PK metadata unavailable/not enforced on this table - fall back to full-row matching
      primaryKeys = [];
    }

    const includedColumns = new Set(resolvedSources.map(source => String(source.sourceColumn).toUpperCase()));
    const columnMeta = resolvedSources.map(source => ({
      name: cols[source.index],
      sourceColumn: source.sourceColumn,
      table: source.table,
      schema: source.schema,
      isPk: primaryKeys.includes(String(source.sourceColumn).toUpperCase()),
      editable: true,
    }));
    if (primaryKeys.length && !primaryKeys.every(column => includedColumns.has(column))) {
      return { columnMeta, editable: false, nonEditableReason: 'Result must include every primary key column.' };
    }
    return { columnMeta, editable: true };
  }

  private async _ensureSession(bigquery: any, baseOptions: any) {
    if (this._sessionId) return this._sessionId;
    const [job] = await bigquery.createQueryJob({ ...baseOptions, query: 'SELECT 1', createSession: true });
    await job.getQueryResults();
    const [metadata] = await job.getMetadata();
    const sessionId = metadata?.statistics?.sessionInfo?.sessionId;
    if (!sessionId) throw new Error('BigQuery did not return a session id.');
    this._sessionId = sessionId;
    return sessionId;
  }

  private async _runSessionQuery(bigquery: any, baseOptions: any, query: string, params?: any) {
    const [job] = await bigquery.createQueryJob({ ...baseOptions, query, params, connectionProperties: this._buildConnectionProperties() });
    const [rows] = await job.getQueryResults();
    const [metadata] = await job.getMetadata();
    return { rows, metadata };
  }

  public async applyEdits(edits: IBigQueryResultEdit[], _opt: any = {}): Promise<IBigQueryResultEditResponse> {
    if (!edits.length) return { success: true };
    const quoteIdentifier = (identifier: string) => `\`${identifier.replace(/`/g, '')}\``;
    const bigquery = await this.open();
    const baseOptions: any = { location: this.credentials.location };
    let failedIndex = 0;
    let transactionStarted = false;
    try {
      const prepared = edits.map(({ table, primaryKey, changes }, index) => {
        failedIndex = index;
        const changeColumns = Object.keys(changes || {});
        const primaryKeyColumns = Object.keys(primaryKey || {});
        if (!table?.label || !changeColumns.length || !primaryKeyColumns.length ||
          primaryKeyColumns.some(column => primaryKey[column] === undefined) ||
          changeColumns.some(column => changes[column] === undefined)) throw new Error('Invalid edit request.');
        const relation = [table.schema, table.label]
          .filter((identifier): identifier is string => typeof identifier === 'string' && identifier.length > 0)
          .map(quoteIdentifier)
          .join('.');
        const params: any = {};
        const matchParams: any = {};
        const setClause = changeColumns.map((column, i) => { const key = `s${i}`; params[key] = changes[column]; return `${quoteIdentifier(column)} = @${key}`; }).join(', ');
        const whereClause = primaryKeyColumns.map((column, i) => {
          if (primaryKey[column] === null) return `${quoteIdentifier(column)} IS NULL`;
          const key = `w${i}`;
          matchParams[key] = primaryKey[column];
          return `${quoteIdentifier(column)} = @${key}`;
        }).join(' AND ');
        return { relation, setClause, whereClause, matchParams, params: { ...params, ...matchParams } };
      });
      await this._ensureSession(bigquery, baseOptions);
      baseOptions.connectionProperties = this._buildConnectionProperties();
      await this._runSessionQuery(bigquery, baseOptions, 'BEGIN TRANSACTION');
      transactionStarted = true;
      for (let index = 0; index < prepared.length; index++) {
        failedIndex = index;
        const { relation, whereClause, matchParams } = prepared[index];
        const { rows } = await this._runSessionQuery(bigquery, baseOptions, `SELECT COUNT(*) AS matching_count FROM ${relation} WHERE ${whereClause}`, matchParams);
        const count = Number(rows?.[0]?.matching_count);
        if (count !== 1) throw new Error(`Unsafe update for ${relation}: WHERE matches ${Number.isFinite(count) ? count : 'an unknown number of'} rows; expected exactly 1. No changes saved.`);
      }
      for (let index = 0; index < prepared.length; index++) {
        failedIndex = index;
        const { relation, setClause, whereClause, params } = prepared[index];
        const { metadata } = await this._runSessionQuery(bigquery, baseOptions, `UPDATE ${relation} SET ${setClause} WHERE ${whereClause}`, params);
        const affected = Number(metadata?.statistics?.query?.dmlStats?.updatedRowCount ?? metadata?.statistics?.query?.numDmlAffectedRows ?? 0);
        if (affected !== 1) {
          throw new Error('Row matching changed after validation. No changes saved.');
        }
      }
      await this._runSessionQuery(bigquery, baseOptions, 'COMMIT TRANSACTION');
      return { success: true };
    } catch (error) {
      if (transactionStarted) await this._runSessionQuery(bigquery, baseOptions, 'ROLLBACK TRANSACTION').catch(() => undefined);
      return { success: false, failedIndex, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private _buildDmlOutcomeMessage(statementType: string, metadata: any, duration: string): string {
    const queryStats = metadata && metadata.statistics && metadata.statistics.query;
    let affected: number | undefined;
    const dmlStats = queryStats && queryStats.dmlStats;
    if (dmlStats) {
      affected = Number(dmlStats.insertedRowCount || 0) + Number(dmlStats.updatedRowCount || 0) + Number(dmlStats.deletedRowCount || 0);
    } else if (queryStats && queryStats.numDmlAffectedRows !== undefined) {
      affected = Number(queryStats.numDmlAffectedRows);
    }
    const label = statementType || 'Statement';
    return `${label} executed successfully.${affected !== undefined ? ` ${affected} row${affected === 1 ? '' : 's'} affected` : ''} (${duration}).`;
  }

  private async _getPaginationState(bigquery: any, baseSql: string, baseOptions: any, requestId: string, page: number, offset: number, rowsLen: number, hasMore: boolean) {
    this._paginationCache = this._paginationCache || new Map();
    const key = `${requestId} ${baseSql}`;
    const cached = this._paginationCache.get(key);
    const resultId = (cached && cached.resultId) || generateId();

    if (cached && cached.exact) {
      return { total: cached.total, exact: true, resultId };
    }

    const estimate = offset + rowsLen + (hasMore ? 1 : 0);
    let total = estimate;
    let exact = false;

    const skipCount = !!this.credentials.disablePaginationCount;
    if (page === 0 && !skipCount) {
      try {
        const [job] = await bigquery.createQueryJob({ ...baseOptions, query: `SELECT COUNT(1) AS total FROM (${baseSql})` });
        const [countRows] = await job.getQueryResults();
        total = Number(countRows[0].total);
        exact = true;
      } catch (error) {
        total = estimate;
        exact = false;
      }
    }

    if (this._paginationCache.size >= 100 && !this._paginationCache.has(key)) {
      const firstKey = this._paginationCache.keys().next().value;
      if (firstKey !== undefined) this._paginationCache.delete(firstKey);
    }
    this._paginationCache.set(key, { total, exact, resultId });
    return { total, exact, resultId };
  }

  private async _execPaginatedSelect(bigquery: any, rawSql: string, baseOptions: any, opt: any): Promise<NSDatabase.IResult> {
    const page = opt.page || 0;
    const pageSize = opt.pageSize || this.credentials.previewLimit || 100;
    const offset = page * pageSize;
    const base = this._stripTrailingSemicolon(rawSql);
    const limitedSql = `${base} LIMIT ${pageSize + 1} OFFSET ${offset}`;
    const startedAt = Date.now();

    const [job] = await bigquery.createQueryJob({ ...baseOptions, query: limitedSql });
    const [rows] = await job.getQueryResults();
    const hasMore = rows.length > pageSize;
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
    const standardizedRows = await standardizeResult(pageRows);

    const { total, exact, resultId } = await this._getPaginationState(bigquery, base, baseOptions, opt.requestId, page, offset, pageRows.length, hasMore);
    const duration = formatDuration(Date.now() - startedAt);
    const shown = pageRows.length;
    const message = exact
      ? `${shown} row${shown === 1 ? '' : 's'} shown - page ${page + 1} of ${Math.max(1, Math.ceil(total / pageSize))} (${total} total, ${pageSize}/page) in ${duration}.`
      : `${shown} row${shown === 1 ? '' : 's'} shown - page ${page + 1} (${pageSize}/page) in ${duration}.`;

    return {
      cols: standardizedRows && standardizedRows.length ? Object.keys(standardizedRows[0]) : ['No rows returned'],
      connId: this.getId(),
      messages: [{ date: new Date(), message }],
      ...(await this.resolveResultEditability(bigquery, standardizedRows && standardizedRows.length ? Object.keys(standardizedRows[0]) : [], base, baseOptions).catch(() => ({ editable: false, nonEditableReason: 'Unable to resolve table metadata for this result.' }))),
      results: standardizedRows,
      query: rawSql,
      requestId: opt.requestId,
      resultId,
      page,
      pageSize,
      total,
      queryType: 'executeQuery',
      queryParams: base,
    } as unknown as NSDatabase.IResult;
  }

  public query: (typeof AbstractDriver)['prototype']['query'] = async (query, opt: any = {}) => {
    const bigquery = await this.open();
    const rawSql = String(query);
    const baseOptions: any = {
      location: this.credentials.location,
    };
    const connectionProperties = this._buildConnectionProperties();
    if (connectionProperties) {
      baseOptions.connectionProperties = connectionProperties;
    }

    const resultsAgg: NSDatabase.IResult[] = [];

    if (!opt.__internal && this._isPaginatableSelect(rawSql)) {
      resultsAgg.push(await this._execPaginatedSelect(bigquery, rawSql, baseOptions, opt));
      return resultsAgg;
    }

    const startedAt = Date.now();
    const [job] = await bigquery.createQueryJob({ ...baseOptions, query: rawSql });
    const [rows] = await job.getQueryResults();
    const [metadata] = await job.getMetadata();
    const duration = formatDuration(Date.now() - startedAt);
    const statementType = metadata?.statistics?.query?.statementType;
    const isSelectLike = !statementType || statementType === 'SELECT' || statementType === 'SCRIPT';
    const standardizedRows = await standardizeResult(rows);

    if (!Array.isArray(rows) || !rows.length) {
      if (isSelectLike) {
        resultsAgg.push({
          cols: ['No rows returned'],
          connId: this.getId(),
          messages: [{ date: new Date(), message: `Query executed successfully. 0 rows retrieved in ${duration}.` }],
          results: [],
          query: rawSql,
          requestId: opt.requestId,
          resultId: generateId(),
        });
      } else {
        const outcome = this._buildDmlOutcomeMessage(statementType, metadata, duration);
        resultsAgg.push({
          cols: ['Statement', 'Result'],
          connId: this.getId(),
          messages: [{ date: new Date(), message: outcome }],
          results: [{ Statement: rawSql, Result: outcome }],
          query: rawSql,
          requestId: opt.requestId,
          resultId: generateId(),
        });
      }
    } else {
      const cols = standardizedRows && standardizedRows.length ? Object.keys(standardizedRows[0]) : [];
      const editability = await this.resolveResultEditability(bigquery, cols || [], rawSql, baseOptions).catch(() => ({ editable: false, nonEditableReason: 'Unable to resolve table metadata for this result.' }));
      resultsAgg.push({
        cols,
        connId: this.getId(),
        messages: [{ date: new Date(), message: `${rows.length} row${rows.length === 1 ? '' : 's'} retrieved in ${duration}.` }],
        ...editability,
        results: standardizedRows,
        query: rawSql,
        requestId: opt.requestId,
        resultId: generateId(),
      });
    }
    return resultsAgg;
  }


  private async getColumns(
    parent: NSDatabase.ITable
  ): Promise<NSDatabase.IColumn[]> {
    const results = await this.queryResults(this.queries.fetchColumns(parent));
    return results.map((col) => ({
      ...col,
      iconName: col.isPk ? "pk" : undefined,
      childType: ContextValue.NO_CHILD,
      table: parent,
    }));
  }



  /**
   * This method is a helper to generate the connection explorer tree.
   * it gets the child items based on current item
   */
  public async getChildrenForItem({
    item,
    parent,
  }: Arg0<IConnectionDriver["getChildrenForItem"]>) {
    switch (item.type) {
      case ContextValue.CONNECTION:
      case ContextValue.CONNECTED_CONNECTION: {
        const projectId = await this.getProjectId();
        return [{ label: projectId, database: projectId, type: ContextValue.DATABASE, detail: 'Project' }];
      }
      case ContextValue.DATABASE: {
        const database = item as NSDatabase.IDatabase;
        const project = database.database || database.label;
        return this.listDatasets(project);
      }
      case ContextValue.SCHEMA:
        return <MConnectionExplorer.IChildItem[]>[
          {
            label: "Tables",
            type: ContextValue.RESOURCE_GROUP,
            iconId: "folder",
            childType: ContextValue.TABLE,
          },
          {
            label: "Views",
            type: ContextValue.RESOURCE_GROUP,
            iconId: "folder",
            childType: ContextValue.VIEW,
          },
          {
            label: "Routines",
            type: ContextValue.RESOURCE_GROUP,
            iconId: "folder",
            childType: ContextValue.FUNCTION,
          }
        ];
      case ContextValue.TABLE:
        return this.getColumns(item as NSDatabase.ITable);
      case ContextValue.VIEW:
        return this.getColumns(item as NSDatabase.ITable);
      case ContextValue.FUNCTION:
        return this.queryResults(this.queries.fetchRoutineInfo(item as NSDatabase.ITable));
      case ContextValue.RESOURCE_GROUP:
        return this.getChildrenForGroup({ item, parent });
    }
    return [];
  }

  /**
   * This method is a helper to generate the connection explorer tree.
   * It gets the child based on child types
   */
  private async getChildrenForGroup({
    parent,
    item,
  }: Arg0<IConnectionDriver["getChildrenForItem"]>) {
    switch (item.childType) {
      case ContextValue.TABLE:
        // return both tables and external tables
        return this.queryResults(
          this.queries.fetchTables(parent as NSDatabase.ISchema)
        );
      case ContextValue.VIEW:
        return this.queryResults(
          this.queries.fetchViews(parent as NSDatabase.ISchema)
        );
      case ContextValue.FUNCTION:
        return this.queryResults(
          this.queries.fetchRoutines(parent as NSDatabase.ISchema)
        );
    }
    return [];
  }

  private cacheCompletionMetadata(
    key: string, load: () => Promise<any[]>, cache = this.completionMetadataCache
  ): Promise<any[]> {
    const cached = cache.get(key);
    if (cached) return cached;
    const pending = Promise.resolve().then(load).catch(error => {
      if (cache.get(key) === pending) cache.delete(key);
      throw error;
    });
    if (cache.size >= 256) {
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) cache.delete(firstKey);
    }
    cache.set(key, pending);
    return pending;
  }

  private async getProjectId(): Promise<string> {
    if (this.credentials.projectId) return this.credentials.projectId;
    const bigquery = await this.open();
    const projectId = typeof bigquery.getProjectId === 'function'
      ? await bigquery.getProjectId() : bigquery.projectId;
    if (!projectId) throw new Error('Unable to resolve the BigQuery project ID. Configure Project ID for this connection.');
    return projectId;
  }

  private async loadCompletionPages(
    load: (options: { autoPaginate: false; maxResults: number; pageToken?: string }) =>
      Promise<[any[], { pageToken?: string }?]>
  ): Promise<any[]> {
    const items: any[] = [];
    const visited = new Set<string>();
    let pageToken: string | undefined;
    do {
      const [page, nextQuery] = await load({ autoPaginate: false, maxResults: 1000, pageToken });
      items.push(...page);
      pageToken = nextQuery?.pageToken;
      if (pageToken) {
        if (visited.has(pageToken)) throw new Error('BigQuery metadata pagination returned a repeated page token.');
        visited.add(pageToken);
      }
    } while (pageToken);
    return items;
  }

  private async listDatasets(projectId: string, search = ''): Promise<any[]> {
    const datasets = await this.cacheCompletionMetadata(JSON.stringify(['datasets', projectId]), async () => {
      const bigquery = await this.open();
      return this.loadCompletionPages(options => bigquery.getDatasets({ ...options, projectId }));
    }, this.datasetMetadataCache);
    return datasets
      .filter((dataset: any) => matchesCompletionName(String(dataset.id || ''), search))
      .sort((left, right) => String(left.id).localeCompare(String(right.id)))
      .map((dataset: any) => ({
        label: dataset.id,
        schema: dataset.id,
        database: projectId,
        type: ContextValue.SCHEMA,
        detail: 'Dataset',
          iconId: 'group-by-ref-type',
      }));
  }

  private async listDatasetTables(projectId: string, datasetId: string, search = ''): Promise<any[]> {
    const tables = await this.cacheCompletionMetadata(JSON.stringify(['tables', projectId, datasetId]), async () => {
      const bigquery = await this.open();
      const dataset = bigquery.dataset(datasetId, { projectId });
      return this.loadCompletionPages(options => dataset.getTables(options));
    });
    return tables
      .filter((table: any) => matchesCompletionName(String(table.id || ''), search))
      .sort((left, right) => String(left.id).localeCompare(String(right.id)))
      .map((table: any) => {
        const metadata = table.metadata || {};
        const objectType = metadata.type === 'VIEW' ? 'View'
          : metadata.type === 'MATERIALIZED_VIEW' ? 'Materialized View'
          : metadata.type === 'EXTERNAL' || metadata.externalDataConfiguration ? 'External Table'
          : metadata.type === 'SNAPSHOT' || metadata.snapshotDefinition ? 'Snapshot'
          : metadata.type === 'CLONE' || metadata.cloneDefinition ? 'Clone'
          : 'Table';
        const isView = objectType === 'View' || objectType === 'Materialized View';
        return {
          label: table.id,
          schema: datasetId,
          database: projectId,
          type: isView ? ContextValue.VIEW : ContextValue.TABLE,
          isView,
          detail: objectType,
        };
      });
  }

  private async searchAllTables(search = ''): Promise<any[]> {
    const projectId = await this.getProjectId();
    const datasets = await this.listDatasets(projectId);
    const tablesPerDataset = await Promise.all(datasets.map(dataset =>
      this.listDatasetTables(projectId, dataset.schema).catch(error => {
        this.log.error(`BigQuery table completion lookup failed for ${projectId}.${dataset.schema}: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      })
    ));
    return ([] as any[]).concat(...tablesPerDataset)
      .filter(table => matchesCompletionName(`${table.schema}.${table.label}`, search))
      .map(table => ({
        ...table,
        description: table.schema,
      }));
  }

  public async getCompletionsForRawQuery(text: string, currentOffset: number): Promise<CompletionItem[]> {
    const beforeCursor = text.slice(0, currentOffset);
    const match = beforeCursor.match(/\b(?:FROM|JOIN)\s+`?([A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*){0,2})$/i);
    if (!match) return null as any;

    const reference = match[1];
    const parts = reference.split('.');
    const trailingDot = reference.endsWith('.');
    const identifiers = trailingDot ? parts.slice(0, -1) : parts;
    try {
      const resolvedProject = await this.getProjectId();
      const configuredProject = resolvedProject.toLowerCase();
      const isProjectQualifier = identifiers.length >= 3 ||
        (identifiers.length > 0 && (identifiers[0].includes('-') || identifiers[0].toLowerCase() === configuredProject));
      const datasetCompletion = (dataset: any, appendDot: boolean): CompletionItem => ({
        label: dataset.label + (appendDot ? '.' : ''),
        detail: 'Dataset',
        filterText: dataset.label,
        sortText: `0:${dataset.label}`,
        kind: CompletionItemKind.Folder,
        documentation: {
          kind: 'markdown',
          value: `\`\`\`yaml\nDataset: ${dataset.label}\nProject: ${dataset.database}\n\`\`\``,
        },
      });
      const tableCompletion = (item: any): CompletionItem => ({
        label: item.label,
        detail: `${item.detail} in ${item.database}.${item.schema}`,
        filterText: item.description ? `${item.schema}.${item.label}` : item.label,
        sortText: `1:${item.schema}.${item.label}`,
        kind: item.isView ? CompletionItemKind.Reference : CompletionItemKind.Constant,
        documentation: {
          kind: 'markdown',
          value: `\`\`\`yaml\n${item.detail}: ${item.label}\nDataset: ${item.schema}\nProject: ${item.database}\n\`\`\``,
        },
      });
      if (!isProjectQualifier && identifiers.length === 1 && !trailingDot) {
        const search = identifiers[0];
        const [datasets, tables] = await Promise.all([
          this.listDatasets(resolvedProject, search),
          this.searchAllTables(search),
        ]);
        return datasets.map(dataset => datasetCompletion(dataset, true)).concat(tables.map(tableCompletion));
      }
      let suggestions: any[];
      if (isProjectQualifier && (identifiers.length === 1 || (identifiers.length === 2 && !trailingDot))) {
        const projectId = identifiers[0];
        const search = identifiers.length === 2 ? identifiers[1] : '';
        suggestions = await this.listDatasets(projectId, search);
        return suggestions.map(dataset => datasetCompletion(dataset, false));
      }

      if (isProjectQualifier && identifiers.length >= 2) {
        suggestions = await this.listDatasetTables(identifiers[0], identifiers[1], identifiers[2] || '');
      } else if (!isProjectQualifier && identifiers.length <= 2) {
        const projectId = resolvedProject;
        const datasetId = identifiers[0];
        const search = identifiers.length === 2 ? identifiers[1] : '';
        suggestions = datasetId ? await this.listDatasetTables(projectId, datasetId, search) : [];
      } else {
        return null as any;
      }

      return suggestions.map(tableCompletion);
    } catch (error) {
      this.log.error(`BigQuery completion lookup failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  /**
   * This method is a helper for intellisense and quick picks.
   */
  public async searchItems(
    itemType: ContextValue,
    search: string,
    extraParams: any = {}
  ): Promise<NSDatabase.SearchableItem[]> {
    switch (itemType) {
      case ContextValue.TABLE:
      case ContextValue.VIEW:
        if (!extraParams.database) return this.searchAllTables(search) as Promise<NSDatabase.SearchableItem[]>;
        return this.listDatasetTables(await this.getProjectId(), extraParams.database, search) as Promise<NSDatabase.SearchableItem[]>;
      case ContextValue.DATABASE:
      case ContextValue.SCHEMA:
        return this.listDatasets(await this.getProjectId(), search) as Promise<NSDatabase.SearchableItem[]>;
      case ContextValue.COLUMN:
        return this.queryResults(
          this.queries.searchColumns({ search, ...extraParams })
        ) as Promise<NSDatabase.SearchableItem[]>;
    }
    return [];
  }

  
  public getStaticCompletions: IConnectionDriver['getStaticCompletions'] = async () => {
    return {};
  }

}
