// node --test watchdog-core.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  checksState,
  describeEvent,
  heldPrs,
  nextSnapshots,
  snapshots,
  stalledPrs,
  transitions,
  unreported,
  wakeClass,
} from './watchdog-core.mjs';

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

const run = (status, conclusion) => ({ status, conclusion });
const ctx = (state) => ({ __typename: 'StatusContext', state });

test('checksState names the checks: none, pending, success or failure', () => {
  const cases = [
    [undefined, 'none'],
    [[], 'none'],
    [[run('COMPLETED', 'SUCCESS'), run('COMPLETED', 'SKIPPED')], 'success'],
    [[run('COMPLETED', 'SUCCESS'), run('IN_PROGRESS', '')], 'pending'],
    [[run('COMPLETED', 'FAILURE'), run('QUEUED', '')], 'pending'],
    [[run('COMPLETED', 'SUCCESS'), run('COMPLETED', 'FAILURE')], 'failure'],
    [[run('COMPLETED', 'CANCELLED')], 'failure'],
    [[ctx('SUCCESS')], 'success'],
    [[ctx('PENDING')], 'pending'],
    [[ctx('ERROR')], 'failure'],
  ];
  for (const [rollup, want] of cases) assert.equal(checksState(rollup), want);
});

const snap = (checks, talk = 0, title = 't') => ({ title, checks, talk });
const kinds = (events) => events.map((e) => [e.number, e.kind]);

test('transitions: each change between two polls is one event', () => {
  const cases = [
    [
      'pending to success',
      snap('pending'),
      snap('success'),
      [[1, 'checks-passed']],
    ],
    [
      'pending to failure',
      snap('pending'),
      snap('failure'),
      [[1, 'checks-failed']],
    ],
    [
      'success to failure on a rerun',
      snap('success'),
      snap('failure'),
      [[1, 'checks-failed']],
    ],
    ['none to pending is not an event', snap('none'), snap('pending'), []],
    [
      'success to pending is not an event',
      snap('success'),
      snap('pending'),
      [],
    ],
    ['unchanged', snap('success', 2), snap('success', 2), []],
    [
      'a new comment',
      snap('success', 1),
      snap('success', 2),
      [[1, 'new-talk']],
    ],
    [
      'fewer comments is not an event',
      snap('success', 2),
      snap('success', 1),
      [],
    ],
    [
      'checks and a comment together',
      snap('pending', 0),
      snap('success', 1),
      [
        [1, 'checks-passed'],
        [1, 'new-talk'],
      ],
    ],
  ];
  for (const [name, was, now, want] of cases)
    assert.deepEqual(kinds(transitions({ 1: was }, { 1: now })), want, name);
});

test('transitions: a PR that left the open list is merged or closed, once resolved', () => {
  const prev = { 1: snap('success'), 2: snap('pending') };
  assert.deepEqual(kinds(transitions(prev, {}, { 1: 'merged', 2: 'closed' })), [
    [1, 'merged'],
    [2, 'closed'],
  ]);
  // A failed lookup yields nothing now, and the PR stays remembered for the next poll.
  assert.deepEqual(transitions(prev, {}, {}), []);
  assert.deepEqual(nextSnapshots(prev, {}, {}), prev);
  assert.deepEqual(nextSnapshots(prev, {}, { 1: 'merged', 2: 'closed' }), {});
});

test('transitions: a new PR and a first poll are baselines, and a replay is silent', () => {
  assert.deepEqual(transitions(undefined, { 1: snap('success') }), []);
  assert.deepEqual(transitions({}, { 1: snap('failure', 3) }), []);
  const prev = { 1: snap('pending') };
  const cur = { 1: snap('success') };
  assert.equal(transitions(prev, cur).length, 1);
  assert.deepEqual(transitions(nextSnapshots(prev, cur), cur), []);
});

test('snapshots count reviews and comments and read the checks', () => {
  assert.deepEqual(
    snapshots([
      {
        number: 9,
        title: 'x',
        statusCheckRollup: [run('COMPLETED', 'SUCCESS')],
        reviews: [{}],
        comments: [{}, {}],
      },
      { number: 10, title: 'y' },
    ]),
    { 9: snap('success', 3, 'x'), 10: snap('none', 0, 'y') },
  );
});

test('wakeClass: error, then event, then quiet, then the timer alone', () => {
  const ev = [{ number: 1, kind: 'merged' }];
  const st = [{ number: 2 }];
  const cases = [
    [{ failed: true, events: ev, stalled: st }, 'error'],
    [{ events: ev, stalled: st }, 'event'],
    [{ stalled: st }, 'quiet'],
    [{}, 'heartbeat'],
  ];
  for (const [input, want] of cases) assert.equal(wakeClass(input), want);
});

test('describeEvent reads as one line naming the PR and the change', () => {
  assert.equal(
    describeEvent({ number: 7, title: 'Add x', kind: 'closed' }),
    '  #7 closed without merging: Add x',
  );
});
