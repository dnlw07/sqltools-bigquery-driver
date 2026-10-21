const BLOCK_STARTERS_AT_STATEMENT_START = new Set(['IF', 'WHILE', 'FOR', 'LOOP', 'REPEAT']);
const END_QUALIFIERS = new Set(['IF', 'WHILE', 'FOR', 'LOOP', 'REPEAT', 'CASE']);
const STATEMENT_START_AFTER = new Set(['THEN', 'ELSE', 'DO', 'BEGIN', 'LOOP', 'REPEAT']);

// Strips leading whitespace and comments, returning the real SQL that is left.
export function stripLeadingNoise(sql: string): string {
  let s = String(sql);
  for (;;) {
    const trimmed = s.replace(/^\s+/, '');
    if (/^(--|#)/.test(trimmed)) {
      const newline = trimmed.indexOf('\n');
      s = newline === -1 ? '' : trimmed.slice(newline + 1);
    } else if (trimmed.startsWith('/*')) {
      const end = trimmed.indexOf('*/');
      s = end === -1 ? '' : trimmed.slice(end + 2);
    } else {
      return trimmed;
    }
  }
}

export function isCommentOnlyStatement(sql: string): boolean {
  return stripLeadingNoise(sql).trim().length === 0;
}

function peekWord(sql: string, from: number): { word: string; end: number } | undefined {
  const match = /^\s*([A-Za-z_]+)/.exec(sql.slice(from, from + 64));
  return match ? { word: match[1].toUpperCase(), end: from + match[0].length } : undefined;
}

// Splits a BigQuery script on top-level semicolons. Semicolons inside strings, quoted identifiers,
// comments and BEGIN/END, IF/LOOP/WHILE/FOR/REPEAT/CASE blocks do not split.
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let depth = 0;
  let statementStart = true;
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === '-' && next === '-' || ch === '#') {
      while (i < sql.length && sql[i] !== '\n') i++;
    } else if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      const raw = /[rR]$/.test(sql.slice(Math.max(0, i - 2), i)) && !/[A-Za-z0-9_]/.test(sql[i - 2] || ' ');
      const triple = ch !== '`' && sql.startsWith(ch.repeat(3), i);
      const closing = triple ? ch.repeat(3) : ch;
      i += closing.length;
      while (i < sql.length && !sql.startsWith(closing, i)) i += !raw && sql[i] === '\\' ? 2 : 1;
      i = Math.min(sql.length, i + closing.length);
      statementStart = false;
    } else if (ch === ';') {
      i++;
      if (depth === 0) {
        statements.push(sql.slice(start, i));
        start = i;
      }
      statementStart = true;
    } else if (/[A-Za-z_]/.test(ch) && sql[i - 1] !== '.') {
      let end = i;
      while (end < sql.length && /[A-Za-z0-9_]/.test(sql[end])) end++;
      const word = sql.slice(i, end).toUpperCase();
      const following = peekWord(sql, end);
      const followingChar = /^\s*(\S?)/.exec(sql.slice(end, end + 64))?.[1] || '';
      i = end;

      if (word === 'BEGIN') {
        if (following?.word !== 'TRANSACTION' && followingChar !== ';' && followingChar !== '') depth++;
      } else if (word === 'CASE') {
        depth++;
      } else if (BLOCK_STARTERS_AT_STATEMENT_START.has(word) && statementStart && followingChar !== '.') {
        depth++;
      } else if (word === 'END') {
        if (following && END_QUALIFIERS.has(following.word)) i = following.end;
        depth = Math.max(0, depth - 1);
      }
      statementStart = STATEMENT_START_AFTER.has(word);
    } else {
      if (!/\s/.test(ch)) statementStart = false;
      i++;
    }
  }

  if (start < sql.length) statements.push(sql.slice(start));
  return statements.filter(statement => statement.trim().length > 0);
}
