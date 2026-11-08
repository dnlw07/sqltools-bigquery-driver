const assert = require('node:assert/strict');
const { test } = require('node:test');
const BigQueryDriver = require('../out/ls/driver').default;

const block = sql => {
  if (/drop\s+table|update/i.test(sql)) throw new Error('SQL execution blocked');
};

test('BigQuery checks the complete script before opening the connection', async () => {
  const driver = new BigQueryDriver({ id: 'test', name: 'test', driver: 'BigQuery' }, async () => []);
  let opened = false;
  driver.open = async () => { opened = true; };
  driver.setSqlExecutionGuard(block);
  await assert.rejects(driver.query('SELECT 1; DROP TABLE prod.users', {}), /blocked/);
  assert.equal(opened, false);
});

test('BigQuery preflights grid updates before executing a transaction', async () => {
  const driver = new BigQueryDriver({ id: 'test', name: 'test', driver: 'BigQuery' }, async () => []);
  let executed = false;
  driver.open = async () => ({ createQueryJob() { executed = true; } });
  driver.setSqlExecutionGuard(block);
  const result = await driver.applyEdits([{ table: { schema: 'S', label: 'T' }, primaryKey: { ID: 1 }, changes: { NAME: 'x' } }]);
  assert.equal(result.success, false);
  assert.match(result.error, /blocked/);
  assert.equal(executed, false);
});

test('BigQuery guards generated jobs and queries', () => {
  const driver = new BigQueryDriver({ id: 'test', name: 'test', driver: 'BigQuery' }, async () => []);
  let calls = 0;
  const client = driver.guardBigQuery({ query() { calls++; }, createQueryJob() { calls++; } });
  driver.setSqlExecutionGuard(block);
  assert.throws(() => client.query('DROP TABLE prod.users'), /blocked/);
  assert.throws(() => client.createQueryJob({ query: 'UPDATE T SET C = 1' }), /blocked/);
  assert.equal(calls, 0);
});
