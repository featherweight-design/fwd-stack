// The away-window merge rule: refusals only while the window is open or its file is damaged.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { awayMergeRefusal } from './away-merge.mjs';

const FLAGS = ['auto', 'admin', 'queue', 'api'];

test('present user: every flag passes through unchanged', () => {
  for (const f of FLAGS) assert.equal(awayMergeRefusal([f], 'present'), null);
});

test('window open: each flag is refused with the way out', () => {
  for (const f of FLAGS) {
    const r = awayMergeRefusal([f], 'away');
    assert.match(r, /user is away/, f);
    assert.match(r, /wait for the user/, f);
    assert.match(r, /green on the current head/, f);
  }
});

test('no known flag means no refusal, even for names on Object.prototype', () => {
  for (const flags of [[], [''], ['unknown-flag'], ['constructor', 'toString']])
    assert.equal(awayMergeRefusal(flags, 'away'), null, flags.join());
});

test('a damaged window file never loosens the rule: flags are refused', () => {
  assert.match(awayMergeRefusal(['auto'], 'unknown'), /cannot be read/);
  assert.equal(awayMergeRefusal([], 'unknown'), null);
});

test('several flags are named together', () => {
  const r = awayMergeRefusal(['auto', 'admin'], 'away');
  assert.match(r, /--auto/);
  assert.match(r, /--admin/);
});
