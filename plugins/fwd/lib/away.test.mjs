import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  awayState,
  awayUntil,
  awayWindow,
  clearAway,
  setAway,
} from './away.mjs';

// CLAUDE_CONFIG_DIR is scratch too: awayState also reads the derived folder under it, never the
// real one.
const env = () => ({
  CLAUDE_PLUGIN_DATA: mkdtempSync(join(tmpdir(), 'away-')),
  CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'away-config-')),
});

test('a window is open until it expires, then the user is present', () => {
  const e = env();
  assert.equal(awayUntil(e), null);
  const until = setAway(10, e, 1_000);
  assert.equal(until, 1_000 + 10 * 3_600_000);
  assert.equal(awayUntil(e, until - 1), until);
  assert.equal(awayUntil(e, until), null);
});

test('clearing the window marks the user present', () => {
  const e = env();
  setAway(8, e);
  clearAway(e);
  assert.equal(awayUntil(e), null);
});

test('a window needs a positive length', () => {
  assert.throws(() => setAway(0, env()), /positive/);
  assert.throws(() => setAway(Number('x'), env()), /positive/);
});

test('extending a window replaces it and leaves no temporary file behind', () => {
  const e = env();
  setAway(1, e, 0);
  const until = setAway(10, e, 0);
  assert.equal(awayUntil(e, 1), until);
  assert.deepEqual(readdirSync(e.CLAUDE_PLUGIN_DATA), ['away.json']);
});

test('awayState reads away, present and expired apart', () => {
  const e = env();
  assert.equal(awayState(e), 'present'); // no file
  const until = setAway(1, e, 1_000);
  assert.equal(awayState(e, until - 1), 'away');
  assert.equal(awayState(e, until), 'present'); // expired
  clearAway(e);
  assert.equal(awayState(e), 'present');
});

test('a file that exists but cannot be parsed is unknown, never present', () => {
  for (const body of [
    '{"until":',
    '',
    'null',
    '{"until":"soon"}',
    '{}',
    '[]',
  ]) {
    const e = env();
    writeFileSync(join(e.CLAUDE_PLUGIN_DATA, 'away.json'), body);
    assert.equal(awayState(e), 'unknown', JSON.stringify(body));
    // awayUntil keeps its old reading for the callers that rely on it.
    assert.equal(awayUntil(e), null);
  }
});

test('a directory where the file should be is unknown', () => {
  const e = env();
  mkdirSync(join(e.CLAUDE_PLUGIN_DATA, 'away.json'));
  assert.equal(awayState(e), 'unknown');
});

test('a window written to the derived folder is seen when the exported folder differs', () => {
  // The writer, run from Bash, has no exported folder; a hook may have a differently named one.
  const config = mkdtempSync(join(tmpdir(), 'away-config-'));
  const until = setAway(1, { CLAUDE_CONFIG_DIR: config }, 1_000);
  const hook = {
    CLAUDE_CONFIG_DIR: config,
    CLAUDE_PLUGIN_DATA: mkdtempSync(join(tmpdir(), 'away-other-')),
  };
  assert.deepEqual(awayWindow(hook, 2_000), { state: 'away', until });
  // A damaged file in one folder is unknown, but an open window in another still wins.
  writeFileSync(join(hook.CLAUDE_PLUGIN_DATA, 'away.json'), '{');
  assert.equal(awayState(hook, 2_000), 'away');
  assert.equal(awayState(hook, until + 1), 'unknown');
});

test('clear removes the window from every folder a reader looks in', () => {
  const config = mkdtempSync(join(tmpdir(), 'away-config-'));
  const e = {
    CLAUDE_CONFIG_DIR: config,
    CLAUDE_PLUGIN_DATA: mkdtempSync(join(tmpdir(), 'away-other-')),
  };
  setAway(1, e);
  setAway(1, { CLAUDE_CONFIG_DIR: config });
  assert.equal(awayState(e), 'away');
  clearAway(e);
  assert.equal(awayState(e), 'present');
});
