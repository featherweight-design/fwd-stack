import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SetupError } from '../feature-acceptance/project.mjs';
import { createReport, pickWidths, press, verdict } from './probe.mjs';

const WIDTHS = [
  { label: 'phone', width: 390, height: 844, touch: true },
  { label: 'desktop', width: 1300, height: 900 },
];

function fakePage() {
  const calls = [];
  return {
    calls,
    touchscreen: { tap: async (x, y) => calls.push(['tap', x, y]) },
    mouse: { click: async (x, y) => calls.push(['click', x, y]) },
  };
}
const locator = (box, seen = []) => ({
  waitFor: async () => {},
  scrollIntoViewIfNeeded: async () => seen.push('scrolled'),
  evaluate: async () => {},
  boundingBox: async () => box,
});

test('press taps at the centre with touch and clicks without', async () => {
  const page = fakePage();
  const box = { x: 10, y: 20, width: 40, height: 10 };
  assert.deepEqual(await press(page, locator(box), { touch: true }), box);
  await press(page, locator(box), { touch: false });
  assert.deepEqual(page.calls, [
    ['tap', 30, 25],
    ['click', 30, 25],
  ]);
});

test('press scrolls the element into view before reading its box', async () => {
  const seen = [];
  await press(
    fakePage(),
    locator({ x: 0, y: 900, width: 10, height: 10 }, seen),
    {
      touch: true,
    },
  );
  assert.deepEqual(seen, ['scrolled']);
});

test('press refuses an element with no box', async () => {
  await assert.rejects(
    press(fakePage(), locator(null), { touch: false }),
    /no box/,
  );
});

test('the report prints a line per check and counts both', () => {
  const lines = [];
  const report = createReport((l) => lines.push(l));
  assert.equal(report.check(true, 'phone: kept focus', 'focused=true'), true);
  assert.equal(report.check(false, 'phone: held its box'), false);
  assert.deepEqual(lines, [
    'PASS  phone: kept focus  (focused=true)',
    'FAIL  phone: held its box',
  ]);
  assert.deepEqual(report.counts(), { passed: 1, failed: 1 });
});

test('verdict: a failure or a throw fails a normal run, and no checks is never a pass', () => {
  assert.equal(verdict({ passed: 3, failed: 0 }).code, 0);
  assert.equal(verdict({ passed: 3, failed: 1 }).code, 1);
  assert.equal(verdict({ passed: 3, failed: 0, threw: true }).code, 1);
  assert.match(verdict({ passed: 0, failed: 0 }).note, /NO CHECKS RAN/);
  assert.equal(verdict({ passed: 0, failed: 0 }, { expectFail: true }).code, 1);
});

test('verdict: a mutation run passes only when a check failed', () => {
  assert.equal(verdict({ passed: 2, failed: 1 }, { expectFail: true }).code, 0);
  const allPassed = verdict({ passed: 3, failed: 0 }, { expectFail: true });
  assert.equal(allPassed.code, 1);
  assert.match(allPassed.note, /does not test the fix/);
  const crashed = verdict(
    { passed: 0, failed: 0, threw: true },
    { expectFail: true },
  );
  assert.equal(crashed.code, 1);
  assert.match(crashed.note, /crashed/);
  // A crash at one width is not hidden by a failed check at another.
  const mixed = verdict(
    { passed: 1, failed: 1, threw: true },
    { expectFail: true },
  );
  assert.equal(mixed.code, 1);
  assert.match(mixed.note, /crashed/);
});

test('pickWidths runs every width unless the probe names some', () => {
  assert.equal(pickWidths(WIDTHS, undefined), WIDTHS);
  assert.deepEqual(pickWidths(WIDTHS, ['phone']), [WIDTHS[0]]);
  assert.throws(
    () => pickWidths(WIDTHS, ['tablet']),
    (e) => e instanceof SetupError && /tablet/.test(e.message),
  );
  assert.throws(() => pickWidths(WIDTHS, []), SetupError);
});
