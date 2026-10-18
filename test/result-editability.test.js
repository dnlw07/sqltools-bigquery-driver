const assert = require('node:assert/strict');
const { test } = require('node:test');
const BigQueryDriver = require('../out/ls/driver').default;

function createDriver(metadataRows = [{ column_name: 'id' }]) {
  const driver = new BigQueryDriver({
    id: 'result-editability',
    name: 'test',
    driver: 'BigQuery',
    projectId: 'my-project-1525987663000',
  }, async () => []);
  const queries = [];
  driver.open = async () => ({
    createQueryJob: async options => {
      queries.push(options.query);
      return [{
        getQueryResults: async () => [metadataRows],
      }];
    },
  });
  return { driver, queries };
}

test('resolves dataset.table metadata through the configured project', async () => {
  const { driver, queries } = createDriver();
  const result = await driver.resolveResultEditability(
    await driver.open(),
    ['id'],
    'SELECT * FROM demo.customers;',
    {},
  );

  assert.equal(result.editable, true);
  assert.equal(result.columnMeta[0].database, 'my-project-1525987663000');
  assert.ok(queries.some(query => /`my-project-1525987663000\.demo\.INFORMATION_SCHEMA\.COLUMNS`/.test(query)));
});

test('uses the project BigQuery actually referenced when it differs from the configured one', async () => {
  const driver = new BigQueryDriver({
    id: 'result-editability', name: 'test', driver: 'BigQuery', projectId: 'configured-project',
  }, async () => []);
  const queries = [];
  const bigquery = {
    createQueryJob: async options => {
      queries.push(options.query);
      return [{
        getMetadata: async () => [{ statistics: { query: { referencedTables: [{ projectId: 'billing-project', datasetId: 'demo', tableId: 'customers' }] } } }],
        getQueryResults: async () => [[{ column_name: 'id' }]],
      }];
    },
  };
  const result = await driver.resolveResultEditability(bigquery, ['id'], 'SELECT * FROM demo.customers;', {});

  assert.equal(result.editable, true);
  assert.equal(result.columnMeta[0].database, 'billing-project');
  assert.ok(queries.some(query => /`billing-project\.demo\.INFORMATION_SCHEMA\.COLUMNS`/.test(query)));
});

test('ignores commented-out FROM clauses when locating the source table', async () => {
  const driver = new BigQueryDriver({
    id: 'result-editability', name: 'test', driver: 'BigQuery', projectId: 'p',
  }, async () => []);
  const queries = [];
  const bigquery = {
    createQueryJob: async options => {
      queries.push(options.query);
      return [{ getMetadata: async () => [{}], getQueryResults: async () => [[{ column_name: 'id' }]] }];
    },
  };
  const result = await driver.resolveResultEditability(bigquery, ['id'], '-- select * from p.demo.products;\n/* from x.y */\nselect * from demo.orders;', {});

  assert.equal(result.editable, true);
  assert.equal(result.columnMeta[0].table, 'orders');
});

test('marks ARRAY/STRUCT/JSON columns as not comparable and keeps editing without a primary key', async () => {
  const driver = new BigQueryDriver({ id: 'result-editability', name: 'test', driver: 'BigQuery', projectId: 'p' }, async () => []);
  const bigquery = {
    createQueryJob: async options => [{
      getQueryResults: async () => [/INFORMATION_SCHEMA\.COLUMNS/.test(options.query)
        ? [
          { column_name: 'id', data_type: 'INT64' },
          { column_name: 'tags', data_type: 'ARRAY<STRING>' },
          { column_name: 'payload', data_type: 'JSON' },
        ]
        : []],
    }],
  };
  const result = await driver.resolveResultEditability(bigquery, ['id', 'tags', 'payload'], 'SELECT * FROM demo.customers;', {});

  assert.equal(result.editable, true);
  assert.deepEqual(result.columnMeta.map(column => column.comparable), [true, false, false]);
});

test('is read-only when no returned column can identify a row', async () => {
  const driver = new BigQueryDriver({ id: 'result-editability', name: 'test', driver: 'BigQuery', projectId: 'p' }, async () => []);
  const bigquery = {
    createQueryJob: async options => [{
      getQueryResults: async () => [/INFORMATION_SCHEMA\.COLUMNS/.test(options.query)
        ? [{ column_name: 'payload', data_type: 'JSON' }]
        : []],
    }],
  };
  const result = await driver.resolveResultEditability(bigquery, ['payload'], 'SELECT payload FROM demo.customers;', {});

  assert.equal(result.editable, false);
});

test('preserves an explicitly qualified project for metadata and edits', async () => {
  const { driver, queries } = createDriver();
  const result = await driver.resolveResultEditability(
    await driver.open(),
    ['id'],
    'SELECT * FROM `other-project.demo.customers`;',
    {},
  );

  assert.equal(result.editable, true);
  assert.equal(result.columnMeta[0].database, 'other-project');
  assert.ok(queries.some(query => /`other-project\.demo\.INFORMATION_SCHEMA\.COLUMNS`/.test(query)));
});
