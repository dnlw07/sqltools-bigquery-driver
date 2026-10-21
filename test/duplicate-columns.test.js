const assert = require('node:assert/strict');
const { test } = require('node:test');
const { resolveRenamedDuplicate } = require('../out/ls/driver');

const known = new Set(['NAME', 'ID', 'NAME_1']);

test('renamed duplicate maps back to the real column', () => {
  assert.equal(resolveRenamedDuplicate(['name', 'id', 'name_1'], 2, new Set(['NAME', 'ID'])), 'name');
});

test('a real column that looks like a rename is kept', () => {
  assert.equal(resolveRenamedDuplicate(['name', 'name_1'], 1, known), 'name_1');
});

test('an unrelated suffix is not remapped', () => {
  assert.equal(resolveRenamedDuplicate(['id', 'foo_1'], 1, new Set(['ID'])), 'foo_1');
});
