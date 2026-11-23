// The away-window rule, run through the gate itself. The window lives in a scratch data folder, and
// PATH holds no `gh`, so the refusals prove they need nothing from GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { setAway } from '../../lib/away.mjs';

const gate = join(dirname(fileURLToPath(import.meta.url)), 'pr-gate.mjs');
const run = (data, ...args) =>
  spawnSync(
    'node',
    [gate, '42', '--action', 'merge', '--repo', 'o/r', ...args],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: dirname(process.execPath),
        CLAUDE_PLUGIN_DATA: data,
      },
    },
  );
const dataDir = () => mkdtempSync(join(tmpdir(), 'gate-away-'));
const open = (d) => setAway(2, { CLAUDE_PLUGIN_DATA: d });

test('away: auto, admin and queue are refused before anything is read from GitHub', () => {
  const d = dataDir();
  open(d);
  for (const f of ['auto', 'admin', 'queue', 'auto,admin']) {
    const r = run(d, '--merge-flags', f);
    assert.equal(r.status, 1, f);
    assert.match(r.stdout, /BLOCKED by pr-review/, f);
    assert.match(r.stdout, /user is away/, f);
  }
});

test('present: a flagged merge is not refused by the away rule', () => {
  const r = run(dataDir(), '--merge-flags', 'auto');
  assert.doesNotMatch(r.stdout, /user is away/);
  assert.doesNotMatch(r.stdout, /away window/);
});

test('away: a plain merge goes on to the normal gate and says the window is open', () => {
  const d = dataDir();
  open(d);
  const r = run(d);
  assert.match(r.stdout, /away window open/);
  assert.doesNotMatch(r.stdout, /user is away/);
});

test('a corrupt window file refuses a flagged merge and leaves a plain one alone', () => {
  const d = dataDir();
  writeFileSync(join(d, 'away.json'), 'not json');
  const flagged = run(d, '--merge-flags', 'auto');
  assert.equal(flagged.status, 1);
  assert.match(flagged.stdout, /cannot be read/);
  assert.doesNotMatch(run(d).stdout, /cannot be read/);
});
