const assert = require('node:assert/strict');
const { test } = require('node:test');
const BigQueryDriver = require('../out/ls/driver').default;

const make = (id, name) => {
  const driver = new BigQueryDriver({ id, name, driver: 'BigQuery', projectId: `proj-${name}` }, async () => []);
  driver.estimateSql = async () => `estimate ${name}`;
  return driver;
};

test('estimate uses the requested connection even when it was never opened or another one is open', async () => {
  const dev = make('dev-id', 'dev');
  const prod = make('prod-id', 'prod');
  dev.constructor.openDrivers.add(dev);
  assert.equal(await BigQueryDriver.estimateFor('prod-id', 'select 1', 'prod'), 'estimate prod');
  assert.equal(await BigQueryDriver.estimateFor('dev-id', 'select 1', 'dev'), 'estimate dev');
  await dev.close();
  await prod.close();
});

test('estimate never falls back to a different connection', async () => {
  const dev = make('dev2-id', 'dev2');
  const message = await BigQueryDriver.estimateFor('other-id', 'select 1', 'other');
  assert.equal(message, undefined);
  await dev.close();
});

test('testConnection keeps the driver registered for estimates', async () => {
  const prod = make('prod3-id', 'prod3');
  prod.open = async () => {
    BigQueryDriver.openDrivers.add(prod);
    prod._bigqueryConnection = Promise.resolve({});
    return { query: async () => [] };
  };
  await prod.testConnection();
  assert.equal(await BigQueryDriver.estimateFor('prod3-id', 'select 1', 'prod3'), 'estimate prod3');
  await prod.close();
});
