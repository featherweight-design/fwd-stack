// node --test watchdog-core.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  checksState,
  climb,
  describeRung,
  FLAG_RUNG,
  describeEvent,
  heldPrs,
  lookupBatch,
  MAX_LOOKUPS,
  MAX_MISS,
  nextSnapshots,
  quietedNumbers,
  readLadder,
  snapshots,
  stalledPrs,
  transitions,
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

const run = (status, conclusion) => ({ status, conclusion });
const ctx = (state) => ({ __typename: 'StatusContext', state });

test('checksState names the checks: none, pending, success or failure', () => {
  const cases = [
    [undefined, 'none'],
    [[], 'none'],
    [[run('COMPLETED', 'SUCCESS'), run('COMPLETED', 'SKIPPED')], 'success'],
    [[run('COMPLETED', 'SUCCESS'), run('IN_PROGRESS', '')], 'pending'],
    // Deliberate: pending wins over a red check until every check has finished.
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

test('snapshots skip drafts and held PRs, so they raise no events', () => {
  const base = { title: 't', statusCheckRollup: [] };
  const out = snapshots([
    { ...base, number: 1 },
    { ...base, number: 2, isDraft: true },
    { ...base, number: 3, labels: [{ name: 'hold' }] },
    { ...base, number: 4, labels: [{ name: 'bug' }] },
  ]);
  assert.deepEqual(Object.keys(out), ['1', '4']);
});

test('a PR that turns draft or held forgets its snapshot, so a later merge raises no event', () => {
  const prs = [
    { number: 1, isDraft: true },
    { number: 2, labels: [{ name: 'hold' }] },
    { number: 3, labels: [] },
  ];
  assert.deepEqual(quietedNumbers(prs), [1, 2]);
  const prev = { 1: snap('success'), 2: snap('success'), 3: snap('success') };
  assert.deepEqual(
    Object.keys(nextSnapshots(prev, {}, {}, [], quietedNumbers(prs))),
    ['3'],
  );
});

test('snapshots do not count the user or bot authors as new talk', () => {
  const by = (login) => ({ author: login ? { login } : undefined });
  const p = {
    number: 1,
    title: 't',
    reviews: [by('me'), by('ci-helper[bot]'), by('other')],
    comments: [by('Me'), by('dependabot[bot]'), by('other'), by(null)],
  };
  const talk = (me) => snapshots([p], me)[1].talk;
  assert.equal(talk('me'), 3); // other review, other comment, authorless comment
  assert.equal(talk(null), 5); // login lookup failed: only bots are filtered
});

test('a gone PR that never resolves is dropped after five misses, five lookups at a time', () => {
  let snaps = { 1: snap('success') };
  for (let i = 1; i < MAX_MISS; i++) {
    assert.deepEqual(lookupBatch(snaps, []), ['1']);
    snaps = nextSnapshots(snaps, {}, {}, ['1']);
    assert.equal(snaps[1].miss, i);
  }
  assert.deepEqual(nextSnapshots(snaps, {}, {}, ['1']), {});
  // Untried PRs are kept as they were; an open PR is never looked up.
  assert.deepEqual(nextSnapshots(snaps, {}, {}, []), snaps);
  assert.deepEqual(lookupBatch({ 1: snap('success') }, [1]), []);
  const many = Object.fromEntries(
    [1, 2, 3, 4, 5, 6, 7].map((n) => [n, snap('success')]),
  );
  assert.equal(lookupBatch(many, []).length, MAX_LOOKUPS);
  assert.deepEqual(
    lookupBatch({ 1: { ...snap('x'), miss: 3 }, 2: snap('x') }, []),
    ['2', '1'],
  );
});

test('wakeClass: event, then quiet, then the timer alone', () => {
  const ev = [{ number: 1, kind: 'merged' }];
  const st = [{ number: 2 }];
  const cases = [
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

const quiet = (number, minutes, at = 'u1') => ({
  number,
  updatedAt: at,
  quietMinutes: minutes,
});

test('climb: a PR reaches rungs 1 to 3 as it stays quiet, once each', () => {
  const cases = [
    [29, undefined, null],
    [30, undefined, 1],
    [45, { rung: 1, at: 'u1' }, null],
    [60, { rung: 1, at: 'u1' }, 2],
    [119, { rung: 2, at: 'u1' }, null],
    [120, { rung: 2, at: 'u1' }, 3],
    [500, undefined, 3], // first seen long after: straight to the highest timed rung
  ];
  for (const [minutes, was, want] of cases) {
    const { due, next } = climb([quiet(1, minutes)], was && { 1: was });
    assert.equal(due[0]?.rung ?? null, want, `${minutes}m after ${was?.rung}`);
    assert.equal(next[1]?.rung ?? 0, want ?? was?.rung ?? 0);
  }
});

test('climb: rung 4 is the next wake after rung 3, and then stays put', () => {
  const at3 = { 1: { rung: 3, at: 'u1' } };
  const { due, next } = climb([quiet(1, 130)], at3);
  assert.deepEqual(
    due.map((p) => p.rung),
    [FLAG_RUNG],
  );
  assert.deepEqual(climb([quiet(1, 400)], next).due, []);
});

test('climb: new activity, an event, or leaving the stalled list resets the rung', () => {
  const was = { 1: { rung: 3, at: 'u1' }, 2: { rung: 2, at: 'u1' } };
  // updatedAt moved: starts over at rung 1.
  assert.equal(climb([quiet(1, 35, 'u2')], was).due[0].rung, 1);
  // an event on the PR, same updatedAt.
  assert.equal(climb([quiet(2, 70)], was, [2]).due[0].rung, 2);
  assert.equal(climb([quiet(2, 40)], was, [2]).due[0].rung, 1);
  // no longer stalled (or held, drafted, merged): dropped from the stored ladder.
  assert.deepEqual(climb([], was).next, {});
});

test('readLadder keeps good entries and starts over on damage', () => {
  assert.deepEqual(readLadder({ 1: { rung: 2, at: 'u' } }), {
    1: { rung: 2, at: 'u' },
  });
  for (const bad of [
    undefined,
    null,
    'x',
    [],
    { 1: { rung: 9, at: 'u' } },
    { 1: 3 },
  ])
    assert.deepEqual(readLadder(bad), {});
});

test('the rung and its instruction are named for the orchestrator', () => {
  assert.match(describeRung({ rung: 1 }), /^ {4}rung 1: nudge: tell the lane/);
  assert.match(describeRung({ rung: 4 }), /flag for the user/);
});
