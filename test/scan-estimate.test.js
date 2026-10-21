const assert = require('node:assert/strict');
const { test } = require('node:test');
const BigQueryDriver = require('../out/ls/driver').default;

function setup({ estimate = { totalBytesProcessed: '10485760', totalBytesBilled: '10485760' }, estimateError } = {}) {
  const calls = [];
  const driver = new BigQueryDriver({
    id: 'scan-estimate', name: 'test', driver: 'BigQuery', disablePagination: true, estimateQuery: true,
  }, async () => []);
  driver.log = { warn: () => {}, error: () => {} };
  driver.open = async () => ({
    createQueryJob: async options => {
      calls.push(options);
      if (options.dryRun) {
        if (estimateError) throw estimateError;
        return [{ metadata: { statistics: { query: estimate } } }];
      }
      return [{
        getQueryResults: async () => [[{ id: 1 }], null, { schema: { fields: [{ name: 'id' }] } }],
        getMetadata: async () => [{ statistics: { query: { statementType: 'SELECT' } } }],
      }];
    },
  });
  driver.resolveResultEditability = async () => ({ editable: false });
  return { driver, calls };
}

test('estimates processed and billed bytes with a dry-run without executing the query', async () => {
  const { driver, calls } = setup();
  const message = await driver.estimateSql('SELECT id FROM employees;');
  assert.equal(message, 'Estimated bytes scanned: 10 MiB processed, 10 MiB billed.');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].dryRun, true);
  assert.equal(calls[0].query, 'SELECT id FROM employees');
});

test('supports dry-run metadata without billed-byte statistics', async () => {
  const { driver } = setup({ estimate: { totalBytesProcessed: 500 } });
  assert.equal(await driver.estimateSql('SELECT 1'), 'Estimated bytes scanned: 500 B.');
});

test('does not return an estimate when BigQuery has no processed-byte statistics', async () => {
  const { driver } = setup({ estimate: {} });
  assert.equal(await driver.estimateSql('SELECT 1'), undefined);
});

test('returns no estimate when dry-run fails while retaining an internal warning', async () => {
  const { driver } = setup({ estimateError: new Error('permission denied') });
  assert.equal(await driver.estimateSql('SELECT 1'), undefined);
});

test('does not run a dry-run or add estimate messages when executing a query', async () => {
  const { driver, calls } = setup();
  const [result] = await driver.query('SELECT id FROM employees', { requestId: 'scan' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].dryRun, undefined);
  assert.equal(result.messages.length, 1);
  assert.match(result.messages[0].message, /1 row retrieved/);
});
