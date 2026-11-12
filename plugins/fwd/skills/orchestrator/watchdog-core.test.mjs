// node --test watchdog-core.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { heldPrs, stalledPrs, unreported } from './watchdog-core.mjs';

const now = Date.parse('2026-10-27T21:00:00Z');
const pr = (number, updatedAt, isDraft = false) => ({
  number,
  updatedAt,
  isDraft,
});

test('an open PR quiet for 30 minutes or more is stalled, the quietest first', () => {
  const out = stalledPrs(
    [
      pr(1, '2026-10-27T20:45:00Z'),
      pr(2, '2026-10-27T20:30:00Z'),
      pr(3, '2026-10-27T19:00:00Z'),
    ],
    now,
  );
  assert.deepEqual(
    out.map((p) => [p.number, p.quietMinutes]),
    [
      [3, 120],
      [2, 30],
    ],
  );
});

test('a draft is not a lane waiting on anything', () => {
  assert.deepEqual(stalledPrs([pr(4, '2026-10-27T10:00:00Z', true)], now), []);
});

test('a PR labelled hold is waiting on purpose, not stalled', () => {
  const quiet = '2026-10-27T10:00:00Z';
  assert.deepEqual(
    stalledPrs(
      [
        { ...pr(6, quiet), labels: [{ name: 'hold' }] },
        { ...pr(7, quiet), labels: [{ name: 'Hold' }] },
      ],
      now,
    ),
    [],
  );
  assert.equal(
    stalledPrs([{ ...pr(8, quiet), labels: [{ name: 'bug' }] }], now).length,
    1,
  );
  assert.deepEqual(
    heldPrs(
      [
        { ...pr(6, quiet), labels: [{ name: 'hold' }] },
        { ...pr(8, quiet), labels: [] },
      ],
      now,
    ).map((p) => p.number),
    [6],
  );
});

test('a stalled PR is reported once until something touches it again', () => {
  const stalled = stalledPrs([pr(5, '2026-10-27T19:00:00Z')], now);
  assert.equal(unreported(stalled).length, 1);
  assert.deepEqual(unreported(stalled, { 5: '2026-10-27T19:00:00Z' }), []);
  assert.equal(unreported(stalled, { 5: '2026-10-27T18:00:00Z' }).length, 1);
});
