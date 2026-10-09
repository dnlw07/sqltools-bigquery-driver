const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ContextValue } = require('@sqltools/types');
const { CompletionItemKind } = require('vscode-languageserver');
const BigQueryDriver = require('../out/ls/driver').default;
const { matchesCompletionName } = require('../out/ls/utils');

test('matches prefixes, suffixes, substrings and beginning/end abbreviations in order', () => {
  for (const search of ['', 'customer', 'history', 'order', 'custhist', 'CUSTOMERHISTORY', 'corh']) {
    assert.equal(matchesCompletionName('customer_order_history', search), true, search);
  }
  for (const search of ['historycustomer', 'custxyz', 'customer_order_history_extra', 'ccccc']) {
    assert.equal(matchesCompletionName('customer_order_history', search), false, search);
  }
  assert.equal(matchesCompletionName('annual_report', 'annualreport'), true);
  assert.equal(matchesCompletionName('annual_report', 'annual_report'), true);
});

function setup() {
  const driver = new BigQueryDriver({
    id: 'test', name: 'test', driver: 'BigQuery', projectId: 'test-project',
  }, async () => []);
  driver.open = async () => ({
    getDatasets: async () => [[{ id: 'customer_order_history' }, { id: 'hr' }]],
    dataset: dataset => ({
      getTables: async () => [[{
        id: dataset === 'hr' ? 'customer_order_history' : 'annual_sales_report',
        metadata: { type: dataset === 'hr' ? 'VIEW' : 'TABLE' },
      }]],
    }),
  });
  return driver;
}

async function complete(driver, sql) {
  const initial = await driver.getCompletionsForRawQuery(sql, sql.length);
  if (initial?.isIncomplete) {
    for (const catalog of driver.completionCatalogs.values()) await catalog.ready();
  }
  return (await driver.getCompletionsForRawQuery(sql, sql.length)).items;
}

for (const sql of [
  'SELECT * FROM custhist',
  'SELECT * FROM `CUSTHIST',
  'SELECT * FROM hr.some_table JOIN custhist',
  'SELECT * FROM `test-project.custhist',
]) {
  test(`finds abbreviated dataset names: ${sql}`, async () => {
    const items = await complete(setup(), sql);
    assert.equal(items[0].kind, CompletionItemKind.Folder);
    assert.equal(items[0].filterText, 'customer_order_history');
    assert.match(items[0].label, /^customer_order_history\.?$/);
    assert.match(items[0].documentation.value, /Dataset: customer_order_history/);
    assert.equal(items[0].sortText, '0:customer_order_history');
  });
}

for (const sql of [
  'SELECT * FROM hr.custhist',
  'SELECT * FROM `test-project.hr.CUSTHIST',
  'SELECT * FROM hr.some_table JOIN hr.custhist',
]) {
  test(`finds abbreviated table names within the selected dataset: ${sql}`, async () => {
    const items = await complete(setup(), sql);
    assert.equal(items.length, 1);
    assert.equal(items[0].label, 'customer_order_history');
    assert.equal(items[0].filterText, 'customer_order_history');
    assert.equal(items[0].kind, CompletionItemKind.Reference);
    assert.match(items[0].documentation.value, /Dataset: hr/);
  });
}

test('uses the same abbreviated matching for schema and table lookup APIs', async () => {
  const driver = setup();
  const datasets = await driver.searchItems(ContextValue.SCHEMA, 'custhist');
  assert.deepEqual(datasets.map(item => item.label), ['customer_order_history']);
  const tables = await driver.searchItems(ContextValue.TABLE, 'custhist', { database: 'hr' });
  assert.deepEqual(tables.map(item => item.label), ['customer_order_history']);
  const allTables = await driver.searchItems(ContextValue.TABLE, 'annualreport');
  assert.deepEqual(allTables.map(item => item.label), ['annual_sales_report']);
});

test('unqualified table filter text retains dataset matches for editor-side filtering', async () => {
  const sql = 'SELECT * FROM hrcusthist';
  const items = await complete(setup(), sql);
  assert.equal(items.length, 1);
  assert.equal(items[0].label, 'customer_order_history');
  assert.equal(items[0].filterText, 'hr.customer_order_history');
  assert.equal(matchesCompletionName(items[0].filterText, 'hrcusthist'), true);
});

test('does not return objects whose characters are out of order', async () => {
  const sql = 'SELECT * FROM hr.histcust';
  assert.deepEqual(await complete(setup(), sql), []);
});
