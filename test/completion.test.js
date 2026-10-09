const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CompletionItemKind } = require('vscode-languageserver');
const { ContextValue } = require('@sqltools/types');
const BigQueryDriver = require('../out/ls/driver').default;
const queries = require('../out/ls/queries').default;

function setup() {
  const tables = [
    { id: 'employees', metadata: { type: 'TABLE' } },
    { id: 'active_employees', metadata: { type: 'VIEW' } },
    { id: 'summary', metadata: { type: 'MATERIALIZED_VIEW' } },
    { id: 'external', metadata: { type: 'EXTERNAL' } },
    { id: 'snapshot', metadata: { type: 'SNAPSHOT' } },
    { id: 'clone', metadata: { type: 'TABLE', cloneDefinition: {} } },
  ];
  const driver = new BigQueryDriver({
    id: 'test', name: 'test', driver: 'BigQuery', projectId: 'test-project',
  }, async () => []);
  driver.open = async () => ({
    projectId: 'test-project',
    getDatasets: async options => {
      assert.equal(options.projectId, 'test-project');
      return [[{ id: 'hr' }]];
    },
    dataset: (dataset, options) => {
      assert.equal(dataset, 'hr');
      assert.equal(options.projectId, 'test-project');
      return { getTables: async () => [tables] };
    },
  });
  return driver;
}

async function complete(driver, sql) {
  return driver.getCompletionsForRawQuery(sql, sql.length);
}

test('qualified table completions show type, dataset and project documentation', async () => {
  const results = await complete(setup(), 'SELECT * FROM `test-project.hr.');
  const types = {
    employees: 'Table', active_employees: 'View', summary: 'Materialized View',
    external: 'External Table', snapshot: 'Snapshot', clone: 'Clone',
  };
  for (const item of results) {
    assert.equal(item.detail, `${types[item.label]} in test-project.hr`);
    assert.equal(item.documentation.kind, 'markdown');
    assert.equal(item.documentation.value,
      `\`\`\`yaml\n${types[item.label]}: ${item.label}\nDataset: hr\nProject: test-project\n\`\`\``);
    assert.equal(item.kind, ['View', 'Materialized View'].includes(types[item.label]) ? CompletionItemKind.Reference : CompletionItemKind.Constant);
    assert.equal(item.filterText, item.label);
    assert.equal(item.insertText, undefined);
  }
});

test('dataset completion shows a documentation panel without changing inserted labels', async () => {
  const results = await complete(setup(), 'SELECT * FROM test-project.');
  assert.equal(results.length, 1);
  assert.equal(results[0].label, 'hr');
  assert.equal(results[0].kind, CompletionItemKind.Folder);
  assert.deepEqual(results[0].documentation, {
    kind: 'markdown', value: '```yaml\nDataset: hr\nProject: test-project\n```',
  });
});

test('dataset-qualified references and typed prefixes retain object details', async () => {
  const results = await complete(setup(), 'SELECT * FROM hr.active');
  assert.equal(results.length, 1);
  assert.equal(results[0].label, 'active_employees');
  assert.match(results[0].documentation.value, /View: active_employees/);
});

test('unqualified search preserves view flags for shared SQLTools completions', async () => {
  const results = await setup().searchItems(ContextValue.TABLE, 'active');
  assert.equal(results.length, 1);
  assert.equal(results[0].isView, true);
  assert.equal(results[0].schema, 'hr');
  assert.equal(results[0].database, 'test-project');
});

test('fallback catalog query includes project and view classification', () => {
  const sql = queries.searchTables({ database: 'test-project.hr', search: 'employee' });
  assert.match(sql, /table_catalog AS database/);
  assert.match(sql, /table_type IN \('VIEW', 'MATERIALIZED VIEW'\) AS isView/);
});

test('non-relation contexts continue to defer to SQLTools parser', async () => {
  assert.equal(await complete(setup(), 'SELECT * FROM hr.employees WHERE '), null);
});

test('project expansion uses the selected project, not the connection display name', async () => {
  const driver = setup();
  const projects = await driver.getChildrenForItem({
    item: { label: 'BigQuery_dev', type: ContextValue.CONNECTION },
  });
  const datasets = await driver.getChildrenForItem({
    item: projects[0],
    parent: { label: 'BigQuery_dev', type: ContextValue.CONNECTION },
  });
  assert.equal(projects[0].database, 'test-project');
  assert.equal(datasets[0].database, 'test-project');
  assert.equal(datasets[0].label, 'hr');
});

test('unqualified prefixes return datasets before tables including inside backticks', async () => {
  const driver = setup();
  for (const sql of ['SELECT * FROM ', 'SELECT * FROM h', 'SELECT * FROM `h', 'SELECT * FROM hr',
    'SELECT * FROM hr.employees JOIN H', 'SELECT * FROM hr.employees JOIN `H']) {
    const results = await complete(driver, sql);
    assert.equal(results[0].label, 'hr.');
    assert.equal(results[0].kind, CompletionItemKind.Folder);
    assert.equal(results[0].sortText, '0:hr');
    assert.ok(results.slice(1).every(item => item.sortText.startsWith('1:')));
  }
  const datasets = await driver.searchItems(ContextValue.DATABASE, 'h');
  assert.equal(datasets[0].label, 'hr');
  const tables = await driver.searchItems(ContextValue.TABLE, 'active', { database: 'hr' });
  assert.equal(tables.length, 1);
  assert.equal(tables[0].label, 'active_employees');
});

test('loads all dataset pages before filtering, caches them, and finds matches beyond display limits', async () => {
  const driver = setup();
  const requests = [];
  const firstPage = Array.from({ length: 1000 }, (_, i) => ({ id: `dataset_${String(i).padStart(4, '0')}` }));
  driver.open = async () => ({
    getDatasets: async options => {
      requests.push(options);
      assert.equal(options.autoPaginate, false);
      assert.equal(options.maxResults, 1000);
      assert.equal(options.projectId, 'test-project');
      return options.pageToken === 'next'
        ? [[{ id: 'dataset_1000' }, { id: 'late_dataset' }], null]
        : [firstPage, { pageToken: 'next' }];
    },
    dataset: () => ({ getTables: async () => [[]] }),
  });
  const all = await driver.searchItems(ContextValue.SCHEMA, '');
  assert.equal(all.length, 1002);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].pageToken, 'next');
  const prefix = await complete(driver, 'SELECT * FROM dataset_100');
  assert.deepEqual(prefix.map(item => item.label), ['dataset_0100.', 'dataset_1000.']);
  const substring = await complete(driver, 'SELECT * FROM `late');
  assert.deepEqual(substring.map(item => item.label), ['late_dataset.']);
  const qualified = await complete(driver, 'SELECT * FROM `test-project.late');
  assert.deepEqual(qualified.map(item => item.label), ['late_dataset']);
  assert.equal(requests.length, 2);
});

test('dataset matches are retained before hundreds of matching tables', async () => {
  const driver = setup();
  driver.open = async () => ({
    getDatasets: async () => [[{ id: 'z_match' }]],
    dataset: () => ({
      getTables: async () => [Array.from({ length: 650 }, (_, i) => ({
        id: `a_match_${i}`, metadata: { type: 'TABLE' },
      }))],
    }),
  });
  const results = await complete(driver, 'SELECT * FROM match');
  assert.equal(results.length, 651);
  assert.equal(results[0].label, 'z_match.');
  assert.ok(results[0].sortText < results[1].sortText);
  assert.equal(results.slice(0, 500)[0].kind, CompletionItemKind.Folder);
});

test('loads table pages completely and filters matches from later pages', async () => {
  const driver = setup();
  let calls = 0;
  driver.open = async () => ({
    dataset: () => ({
      getTables: async options => {
        calls++;
        assert.equal(options.autoPaginate, false);
        return options.pageToken
          ? [[{ id: 'late_table', metadata: { type: 'VIEW' } }], null]
          : [Array.from({ length: 1000 }, (_, i) => ({ id: `early_${i}`, metadata: { type: 'TABLE' } })), { pageToken: 'next' }];
      },
    }),
  });
  const results = await complete(driver, 'SELECT * FROM hr.late');
  assert.equal(calls, 2);
  assert.equal(results.length, 1);
  assert.equal(results[0].label, 'late_table');
  assert.equal(results[0].kind, CompletionItemKind.Reference);
});

test('a failed page is not cached as a partial successful dataset list', async () => {
  const driver = setup();
  let fail = true;
  driver.open = async () => ({
    getDatasets: async options => {
      if (!options.pageToken) return [[{ id: 'hr' }], { pageToken: 'next' }];
      if (fail) throw new Error('page denied');
      return [[{ id: 'late' }], null];
    },
  });
  await assert.rejects(driver.searchItems(ContextValue.SCHEMA, ''), /page denied/);
  fail = false;
  assert.deepEqual((await driver.searchItems(ContextValue.SCHEMA, '')).map(item => item.label), ['hr', 'late']);
});

test('rejects repeated metadata page tokens rather than looping', async () => {
  const driver = setup();
  driver.open = async () => ({
    getDatasets: async () => [[{ id: 'hr' }], { pageToken: 'same' }],
  });
  await assert.rejects(driver.searchItems(ContextValue.SCHEMA, ''), /repeated page token/);
});

test('dataset suggestions survive a table lookup failure with an explicit error log', async () => {
  const driver = setup();
  const errors = [];
  driver.log.error = message => errors.push(message);
  driver.open = async () => ({
    getDatasets: async () => [[{ id: 'hr' }]],
    dataset: () => ({ getTables: async () => { throw new Error('table access denied'); } }),
  });
  const results = await complete(driver, 'SELECT * FROM h');
  assert.deepEqual(results.map(item => item.label), ['hr.']);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /test-project\.hr.*table access denied/);
});

test('closing the connection invalidates the complete dataset cache', async () => {
  const driver = setup();
  let datasetId = 'hr';
  driver.open = async () => ({
    getDatasets: async () => [[{ id: datasetId }]],
  });
  assert.equal((await driver.searchItems(ContextValue.SCHEMA, ''))[0].label, 'hr');
  datasetId = 'new_dataset';
  await driver.close();
  assert.equal((await driver.searchItems(ContextValue.SCHEMA, ''))[0].label, 'new_dataset');
});

test('dataset-qualified completion does not repeat datasets', async () => {
  const results = await complete(setup(), 'SELECT * FROM hr.');
  assert.ok(results.length > 0);
  assert.ok(results.every(item => item.kind !== CompletionItemKind.Folder));
});

test('service-account project resolution uses asynchronous client discovery', async () => {
  const driver = setup();
  delete driver.credentials.projectId;
  const open = driver.open;
  driver.open = async () => ({
    ...await open(),
    projectId: '{{projectId}}',
    getProjectId: async () => 'test-project',
  });
  const projects = await driver.getChildrenForItem({
    item: { label: 'BigQuery_dev', type: ContextValue.CONNECTION },
  });
  assert.equal(projects[0].label, 'test-project');
  const results = await complete(driver, 'SELECT * FROM test-project.');
  assert.equal(results[0].label, 'hr');
});
