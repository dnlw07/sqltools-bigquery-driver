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
