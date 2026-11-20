// node --test session-env.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sessionId, writeEnv } from './session-env.mjs';

const hook = join(dirname(fileURLToPath(import.meta.url)), 'session-env.mjs');
const input = (id) => JSON.stringify({ session_id: id });

test('sessionId accepts letters, digits and hyphens', () => {
  assert.equal(sessionId(input('3f2a-9B')), '3f2a-9B');
});

test('sessionId rejects anything unsafe to source as shell', () => {
  for (const bad of ['a b', 'a;rm -rf /', '$(x)', 'a\nb', '', 'a"b', 5, null]) {
    assert.equal(sessionId(input(bad)), null, String(bad));
  }
  assert.equal(sessionId('not json'), null);
  assert.equal(sessionId('{}'), null);
});

test('writeEnv appends one export line and keeps earlier lines', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'senv-')), 'env.sh');
  writeFileSync(file, 'export A=1\n');
  assert.equal(writeEnv(input('abc-1'), file), true);
  assert.equal(
    readFileSync(file, 'utf8'),
    'export A=1\n\nexport CLAUDE_SESSION_ID=abc-1\n',
  );
});

test('writeEnv writes nothing without a file or with a bad id', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'senv-')), 'env.sh');
  assert.equal(writeEnv(input('abc'), undefined), false);
  assert.equal(writeEnv(input('a;b'), file), false);
  assert.throws(() => readFileSync(file));
});

test('writeEnv does not throw when the file cannot be written', () => {
  const bad = join(tmpdir(), 'no-such-dir-xyz', 'e.sh');
  assert.equal(writeEnv(input('abc'), bad), false);
});

test('the hook exits 0 and prints nothing, with or without CLAUDE_ENV_FILE', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'senv-')), 'env.sh');
  const env = { ...process.env };
  delete env.CLAUDE_ENV_FILE;
  const bare = spawnSync('node', [hook], {
    input: input('abc'),
    env,
    encoding: 'utf8',
  });
  assert.equal(bare.status, 0);
  assert.equal(bare.stdout, '');
  const set = spawnSync('node', [hook], {
    input: input('abc'),
    env: { ...env, CLAUDE_ENV_FILE: file },
    encoding: 'utf8',
  });
  assert.equal(set.status, 0);
  assert.equal(set.stdout, '');
  assert.equal(readFileSync(file, 'utf8'), '\nexport CLAUDE_SESSION_ID=abc\n');
});
