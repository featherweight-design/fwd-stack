// node --test pr-gate-deny.test.mjs
// The gate refuses every request for a Copilot review without reading anything from GitHub, so
// these run with no network and no `gh`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const gate = join(dirname(fileURLToPath(import.meta.url)), 'pr-gate.mjs');
const run = (...args) =>
  spawnSync('node', [gate, ...args], {
    encoding: 'utf8',
    // A PATH with no `gh` proves the refusal needs nothing from GitHub.
    env: { ...process.env, PATH: dirname(process.execPath) },
  });

test('a review request is refused, with the reason and the way out', () => {
  const r = run('42', '--action', 'rerequest', '--repo', 'o/r');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /BLOCKED by pr-review/);
  assert.match(r.stdout, /Copilot is cut/);
  assert.match(r.stdout, /#42/);
  assert.match(r.stdout, /## Copilot off/);
  assert.match(r.stdout, /\/code-review medium/);
});

test('a review request is refused even with no PR number', () => {
  const r = run('--action', 'rerequest');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Copilot is cut/);
});

test('an unknown --action is refused, not read as report-only', () => {
  const r = run('42', '--action', '--repo', 'o/r');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /unknown --action/);
});
