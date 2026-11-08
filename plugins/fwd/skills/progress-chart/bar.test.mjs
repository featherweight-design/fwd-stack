// node --test bar.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bar, cells, WIDTH } from './bar.mjs';

test('every bar is exactly 20 cells, for every count up to 40 steps', () => {
  for (let total = 1; total <= 40; total++) {
    for (let done = 0; done <= total; done++) {
      for (let inFlight = 0; done + inFlight <= total; inFlight++) {
        const c = cells(done, inFlight, total);
        assert.equal(c[0] + c[1] + c[2], WIDTH, `${done}/${inFlight}/${total}`);
        assert.equal([...bar(done, inFlight, total)].length, WIDTH);
        // No segment strays more than one cell from its exact share.
        [done, inFlight, total - done - inFlight].forEach((n, i) =>
          assert.ok(
            Math.abs(c[i] - (n * WIDTH) / total) < 1,
            `${done}/${inFlight}/${total}`,
          ),
        );
      }
    }
  }
});

test('plain rounding when it already totals 20', () => {
  assert.deepEqual(cells(5, 1, 11), [9, 2, 9]);
  assert.equal(bar(2, 0, 11), '████░░░░░░░░░░░░░░░░');
});

test('an overflow comes off not started first, so a tie never overstates progress', () => {
  // 6.67 each rounds to 7 + 7 + 7 = 21.
  assert.deepEqual(cells(2, 2, 2 + 2 + 2), [7, 7, 6]);
  // 2.5 + 2.5 + 15 rounds to 3 + 3 + 15 = 21; not started was exact, so in flight gives one up.
  assert.deepEqual(cells(1, 1, 8), [3, 2, 15]);
});

test('a shortfall goes to not started first, on an exact tie as well', () => {
  // 13.33 + 3.33 + 3.33 rounds to 13 + 3 + 3 = 19; all three are a third of a cell short.
  assert.deepEqual(cells(4, 1, 6), [13, 3, 4]);
});

test('done never takes or gives the fixing cell while another segment ties with it', () => {
  for (let total = 1; total <= 40; total++) {
    for (let done = 0; done <= total; done++) {
      for (let inFlight = 0; done + inFlight <= total; inFlight++) {
        const counts = [done, inFlight, total - done - inFlight];
        const rounded = counts.map((c) => Math.round((c * WIDTH) / total));
        const err = counts.map((c, i) => c * WIDTH - rounded[i] * total);
        if (err.slice(1).some((e) => e === err[0])) {
          assert.equal(
            cells(done, inFlight, total)[0],
            rounded[0],
            `${done}/${inFlight}/${total}`,
          );
        }
      }
    }
  }
});

test('empty and full lines', () => {
  assert.equal(bar(0, 0, 7), '░'.repeat(20));
  assert.equal(bar(7, 0, 7), '█'.repeat(20));
});

test('bad counts are refused', () => {
  assert.throws(() => cells(1, 0, 0));
  assert.throws(() => cells(3, 3, 5));
  assert.throws(() => cells(-1, 0, 5));
  assert.throws(() => cells(1.5, 0, 5));
});

test('another width sums to that width, and a bad width is refused', () => {
  for (let total = 1; total <= 20; total++) {
    for (let done = 0; done <= total; done++) {
      const out = cells(done, 0, total, 10);
      assert.equal(out[0] + out[1] + out[2], 10);
    }
  }
  assert.throws(() => cells(1, 0, 2, 10.5), /not a bar width/);
  assert.throws(() => cells(1, 0, 2, 0), /not a bar width/);
});
