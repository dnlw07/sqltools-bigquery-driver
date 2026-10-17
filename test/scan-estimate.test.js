const assert = require('node:assert/strict');
const { test } = require('node:test');
const BigQueryDriver = require('../out/ls/driver').default;

function setup({ estimate = { totalBytesProcessed: '10485760', totalBytesBilled: '10485760' }, estimateError } = {}) {
  const calls = [];
  const warnings = [];
  const driver = new BigQueryDriver({
    id: 'scan-estimate', name: 'test', driver: 'BigQuery', disablePagination: true, estimateQuery: true,
  }, async () => []);
  driver.log = { warn: message => warnings.push(message), error: () => {} };
  driver.open = async () => ({
    createQueryJob: async options => {
      calls.push(options);
      if (options.dryRun) {
        if (estimateError) throw estimateError;
        return [{
          getMetadata: async () => [{ statistics: { query: estimate } }],
        }];
      }
      return [{
        getQueryResults: async () => [[{ id: 1 }], null, { schema: { fields: [{ name: 'id' }] } }],
        getMetadata: async () => [{ statistics: { query: { statementType: 'SELECT' } } }],
      }];
    },
  });
  driver.resolveResultEditability = async () => ({ editable: false });
  return { driver, calls, warnings };
}

test('runs a dry-run before execution and reports processed and billed bytes first', async () => {
  const { driver, calls } = setup();
  const [result] = await driver.query('SELECT id FROM employees', { requestId: 'scan' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].dryRun, true);
  assert.equal(calls[0].query, 'SELECT id FROM employees');
  assert.equal(calls[1].dryRun, undefined);
  assert.match(result.messages[0].message, /^Estimated bytes scanned: 10 MiB processed, 10 MiB billed\.$/);
  assert.match(result.messages[1].message, /1 row retrieved/);
});

test('supports dry-run metadata without billed-byte statistics', async () => {
  const { driver } = setup({ estimate: { totalBytesProcessed: 500 } });
  const [result] = await driver.query('SELECT 1', { requestId: 'scan' });
  assert.equal(result.messages[0].message, 'Estimated bytes scanned: 500 B.');
});

test('continues with the actual query when dry-run estimation fails', async () => {
  const { driver, calls, warnings } = setup({ estimateError: new Error('permission denied') });
  const [result] = await driver.query('SELECT id FROM employees', { requestId: 'scan' });
  assert.equal(calls.length, 2);
  assert.equal(result.messages.length, 1);
  assert.match(result.messages[0].message, /1 row retrieved/);
  assert.match(warnings[0], /permission denied/);
});

test('does not run a dry-run when estimation is disabled', async () => {
  const { driver, calls } = setup();
  driver.credentials.estimateQuery = false;
  const [result] = await driver.query('SELECT id FROM employees', { requestId: 'scan' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].dryRun, undefined);
  assert.equal(result.messages.length, 1);
});
