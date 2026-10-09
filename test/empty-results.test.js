const assert = require('node:assert/strict');
const { test } = require('node:test');
const BigQueryDriver = require('../out/ls/driver').default;

function setup(rows = [], statementType = 'SELECT') {
  const driver = new BigQueryDriver({
    id: 'empty-results', name: 'test', driver: 'BigQuery', disablePaginationCount: true,
  }, async () => []);
  driver.open = async () => ({
    createQueryJob: async () => [{
      getQueryResults: async () => [rows, null, {
        schema: { fields: [{ name: 'employee_id' }, { name: 'display_name' }] },
      }],
      getMetadata: async () => [{ statistics: { query: { statementType } } }],
    }],
  });
  driver.resolveResultEditability = async () => ({ editable: false });
  return driver;
}

for (const internal of [false, true]) {
  test(`empty ${internal ? 'regular' : 'paginated'} SELECT preserves schema column names`, async () => {
    const [result] = await setup().query('SELECT * FROM employees', {
      requestId: 'request', __internal: internal,
    });
    assert.deepEqual(result.cols, ['employee_id', 'display_name']);
    assert.deepEqual(result.results, []);
    assert.match(result.messages[0].message, /0 rows/);
    if (!internal) {
      assert.equal(result.page, 0);
      assert.equal(result.total, 0);
    }
  });
}

test('populated SELECT keeps its data and column names', async () => {
  const rows = [{ employee_id: 1, display_name: 'Test' }];
  const [result] = await setup(rows).query('SELECT * FROM employees', { __internal: true });
  assert.deepEqual(result.cols, ['employee_id', 'display_name']);
  assert.deepEqual(result.results, rows);
});

test('zero-row DML keeps its statement outcome rather than rendering a SELECT grid', async () => {
  const [result] = await setup([], 'UPDATE').query('UPDATE employees SET display_name = NULL WHERE FALSE');
  assert.deepEqual(result.cols, ['Statement', 'Result']);
  assert.equal(result.results.length, 1);
  assert.match(result.results[0].Result, /UPDATE executed successfully/);
});
