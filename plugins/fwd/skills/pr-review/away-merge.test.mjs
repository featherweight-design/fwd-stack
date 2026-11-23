// The away-window merge rule: refusals only while the window is open or its file is damaged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { setAway } from '../../lib/away.mjs';
import { awayMergeRefusal } from './away-merge.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'away-merge.mjs');
const env = () => ({
  CLAUDE_PLUGIN_DATA: mkdtempSync(join(tmpdir(), 'away-merge-')),
});
const awayFile = (e) => join(e.CLAUDE_PLUGIN_DATA, 'away.json');

test('present user: every flag passes through unchanged', () => {
  const e = env();
  for (const f of ['auto', 'admin', 'queue'])
    assert.equal(awayMergeRefusal([f], e), null);
});

test('window open: auto, admin and queue are each refused with the way out', () => {
  const e = env();
  setAway(2, e);
  for (const f of ['auto', 'admin', 'queue']) {
    const r = awayMergeRefusal([f], e);
    assert.match(r, /user is away/);
    assert.match(r, /wait for the user/);
    assert.match(r, /green on the current head/);
  }
});

test('window open: no flag means no refusal from this rule', () => {
  const e = env();
  setAway(2, e);
  assert.equal(awayMergeRefusal([], e), null);
  assert.equal(awayMergeRefusal([''], e), null);
});

test('an expired window is present', () => {
  const e = env();
  setAway(1, e, Date.now() - 2 * 3_600_000);
  assert.equal(awayMergeRefusal(['auto'], e), null);
});

test('a damaged window file never loosens the rule: flags are refused', () => {
  const e = env();
  writeFileSync(awayFile(e), '{"until":');
  assert.match(awayMergeRefusal(['auto'], e), /cannot be read/);
  // It adds nothing for a plain merge.
  assert.equal(awayMergeRefusal([], e), null);
});

test('an unreadable path (a directory) is refused too', () => {
  const e = env();
  mkdirSync(awayFile(e));
  assert.match(awayMergeRefusal(['queue'], e), /cannot be read/);
});

test('several flags are named together', () => {
  const e = env();
  setAway(2, e);
  const r = awayMergeRefusal(['auto', 'admin'], e);
  assert.match(r, /--auto/);
  assert.match(r, /--admin/);
});

test('the command line exits 1 with the reason when refused, 0 when not', () => {
  const e = env();
  setAway(2, e);
  const run = (flags, data) =>
    spawnSync('node', [script, flags], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PLUGIN_DATA: data },
    });
  const denied = run('auto', e.CLAUDE_PLUGIN_DATA);
  assert.equal(denied.status, 1);
  assert.match(denied.stdout, /BLOCKED by pr-review/);
  assert.equal(run('auto', env().CLAUDE_PLUGIN_DATA).status, 0);
  assert.equal(run('', e.CLAUDE_PLUGIN_DATA).status, 0);
});
