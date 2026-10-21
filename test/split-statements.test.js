const assert = require('node:assert/strict');
const { test } = require('node:test');
const { splitStatements } = require('../out/ls/splitStatements');
const BigQueryDriver = require('../out/ls/driver').default;

const trimmed = sql => splitStatements(sql).map(statement => statement.trim());

test('splits top-level statements and ignores comment-only tails', () => {
  assert.deepEqual(trimmed('select 1; select 2;\n-- tail'), ['select 1;', 'select 2;', '-- tail']);
});

test('keeps semicolons in strings, quoted identifiers and comments', () => {
  assert.deepEqual(trimmed("select 'a;b', `p;q`.d.t; -- x; y\nselect \"c;d\" /* ; */;"), [
    "select 'a;b', `p;q`.d.t;", '-- x; y\nselect "c;d" /* ; */;',
  ]);
  assert.deepEqual(trimmed("select '''a;b''', r'\\;' ; select 2"), ["select '''a;b''', r'\\;' ;", 'select 2']);
});

test('does not split BEGIN...END, IF, LOOP and CASE blocks', () => {
  const block = 'BEGIN\n DECLARE x INT64 DEFAULT 1;\n IF x > 0 THEN SELECT 1; ELSEIF x < 0 THEN SELECT 2; END IF;\n WHILE x < 3 DO SET x = x + 1; END WHILE;\nEND;';
  assert.deepEqual(trimmed(`${block} select 3;`), [block, 'select 3;']);
  assert.deepEqual(trimmed('select CASE WHEN a THEN 1 END; select 2;'), ['select CASE WHEN a THEN 1 END;', 'select 2;']);
  assert.deepEqual(trimmed('IF x THEN SELECT 1; END IF; select 2;'), ['IF x THEN SELECT 1; END IF;', 'select 2;']);
});

test('BEGIN TRANSACTION and IF() or IF EXISTS are not blocks', () => {
  assert.deepEqual(trimmed('BEGIN TRANSACTION; update t set a = 1; COMMIT TRANSACTION;'),
    ['BEGIN TRANSACTION;', 'update t set a = 1;', 'COMMIT TRANSACTION;']);
  assert.deepEqual(trimmed('select IF(a, 1, 2) from t; drop table if exists x; select 2;'),
    ['select IF(a, 1, 2) from t;', 'drop table if exists x;', 'select 2;']);
});

function setup() {
  const driver = new BigQueryDriver({ id: 'script', name: 'test', driver: 'BigQuery', disablePagination: true }, async () => []);
  const queries = [];
  driver.open = async () => ({
    createQueryJob: async ({ query }) => {
      queries.push(query);
      return [{
        getQueryResults: async () => {
          if (/boom/.test(query)) throw new Error('Syntax error: boom');
          return [[{ n: 1 }], null, { schema: { fields: [{ name: 'n' }] } }];
        },
        getMetadata: async () => [{ statistics: { query: { statementType: 'SELECT' } } }],
      }];
    },
  });
  driver.resolveResultEditability = async () => ({ editable: false });
  return { driver, queries };
}

test('a script produces one result and console message per statement', async () => {
  const { driver, queries } = setup();
  const results = await driver.query('select 1 as n;\n-- note\nselect 2 as n;', { requestId: 'r' });
  assert.equal(results.length, 2);
  assert.equal(queries.length, 2);
  assert.match(queries[0], /^select 1 as n;$/);
  assert.match(queries[1], /select 2 as n;$/);
  results.forEach(result => assert.equal(result.messages.length, 1));
  assert.notEqual(results[0].resultId, results[1].resultId);
});

test('a failing statement is reported on its own and later statements still run', async () => {
  const { driver } = setup();
  const results = await driver.query('select 1 as n; select boom; select 3 as n;', {});
  assert.equal(results.length, 3);
  assert.equal(results[1].error, true);
  assert.match(results[1].messages[0].message, /boom/);
  assert.deepEqual(results[2].results, [{ n: 1 }]);
});

test('a single failing statement still rejects as before', async () => {
  const { driver } = setup();
  await assert.rejects(driver.query('select boom;', {}), /boom/);
});
