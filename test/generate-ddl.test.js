const assert = require('node:assert/strict');
const { test } = require('node:test');
const BigQueryDriver = require('../out/ls/driver').default;

function setup(rows) {
  const calls = [];
  const driver = new BigQueryDriver({ id: 'ddl', name: 'test', driver: 'BigQuery', projectId: 'proj' }, async () => []);
  driver.open = async () => ({
    createQueryJob: async options => {
      calls.push(options);
      return [{ getQueryResults: async () => [rows] }];
    },
  });
  return { driver, calls };
}

test('reads table and view DDL from INFORMATION_SCHEMA.TABLES', async () => {
  const { driver, calls } = setup([{ ddl: 'CREATE TABLE `proj.demo.t` (id INT64)' }]);
  const ddl = await driver.generateDDL({ label: 't', schema: 'demo', database: 'proj', type: 'connection.table' });
  assert.equal(ddl, 'CREATE TABLE `proj.demo.t` (id INT64);\n');
  assert.match(calls[0].query, /`proj\.demo\.INFORMATION_SCHEMA\.TABLES`/);
  assert.deepEqual(calls[0].params, { name: 't' });
});

test('reads routine DDL from INFORMATION_SCHEMA.ROUTINES', async () => {
  const { driver, calls } = setup([{ ddl: 'CREATE PROCEDURE `proj.demo.p`() BEGIN END;' }]);
  const ddl = await driver.generateDDL({ label: 'p', schema: 'demo', type: 'connection.procedure' });
  assert.equal(ddl, 'CREATE PROCEDURE `proj.demo.p`() BEGIN END;\n');
  assert.match(calls[0].query, /`proj\.demo\.INFORMATION_SCHEMA\.ROUTINES`/);
  assert.match(calls[0].query, /routine_name = @name/);
});

test('rejects when BigQuery returns no DDL', async () => {
  const { driver } = setup([]);
  await assert.rejects(driver.generateDDL({ label: 'x', schema: 'demo', type: 'connection.table' }), /no DDL/);
});
