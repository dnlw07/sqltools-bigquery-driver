const assert = require('node:assert/strict');
const { test } = require('node:test');
const BigQueryDriver = require('../out/ls/driver').default;
const queries = require('../out/ls/queries').default;

function createDriver() {
  const driver = new BigQueryDriver({ id: 'columns', name: 'test', driver: 'BigQuery', projectId: 'my-project' }, async () => []);
  const sent = [];
  driver.queryResults = async query => { sent.push(String(query)); return []; };
  return { driver, sent };
}

test('column query uses the table dataset and a valid backtick alias', () => {
  const sql = String(queries.searchColumns({
    search: '', completionCatalog: true,
    tables: [{ label: 't1', schema: 'ds', database: 'my-project' }],
  }));

  assert.match(sql, /FROM `my-project\.ds\.INFORMATION_SCHEMA\.COLUMNS`/);
  assert.match(sql, /AS `table`/);
  assert.doesNotMatch(sql, /"table"|undefined/);
  assert.doesNotMatch(sql, /\bLIMIT\b/);
});

test('column query unions several datasets and keeps the normal limit outside the catalog', () => {
  const sql = String(queries.searchColumns({
    search: "o'x",
    tables: [{ label: 'a', schema: 'ds1', database: 'p' }, { label: 'b', schema: 'ds2', database: 'p' }],
  }));

  assert.match(sql, /`p\.ds1\.INFORMATION_SCHEMA\.COLUMNS`[\s\S]*UNION ALL[\s\S]*`p\.ds2\.INFORMATION_SCHEMA\.COLUMNS`/);
  assert.match(sql, /LIMIT 100/);
  assert.match(sql, /o\\'x/);
});

test('searchItems resolves an unqualified table through the catalog', async () => {
  const { driver, sent } = createDriver();
  driver.searchAllTables = async () => [
    { label: 'T319010_openkyc_reports', schema: 'ds_a', database: 'my-project' },
    { label: 'other', schema: 'ds_b', database: 'my-project' },
  ];
  await driver.searchItems('connection.column', '', { tables: [{ label: 't319010_openkyc_reports' }], completionCatalog: true });

  assert.equal(sent.length, 1);
  assert.match(sent[0], /`my-project\.ds_a\.INFORMATION_SCHEMA\.COLUMNS`/);
  assert.match(sent[0], /table_name = 'T319010_openkyc_reports'/);
  assert.doesNotMatch(sent[0], /undefined/);
});

test('searchItems skips the query when the table cannot be located', async () => {
  const { driver, sent } = createDriver();
  driver.searchAllTables = async () => [];

  assert.deepEqual(await driver.searchItems('connection.column', '', { tables: [{ label: 'missing' }] }), []);
  assert.equal(sent.length, 0);
});

test('searchItems keeps an explicit project qualifier', async () => {
  const { driver, sent } = createDriver();
  await driver.searchItems('connection.column', '', { tables: [{ label: 't', schema: 'ds', database: 'other-project' }] });

  assert.match(sent[0], /`other-project\.ds\.INFORMATION_SCHEMA\.COLUMNS`/);
});
