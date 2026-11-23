// node --test status-line.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseStatusLine } from './status-line.mjs';

const cases = [
  ['done: PR #42 merged', { verb: 'done', text: 'PR #42 merged' }],
  ['blocked: waiting on CI', { verb: 'blocked', text: 'waiting on CI' }],
  [
    'needs-decision: ship or hold; default hold',
    { verb: 'needs-decision', text: 'ship or hold; default hold' },
  ],
  ['DONE: shouted', { verb: 'done', text: 'shouted' }],
  [
    'Needs-Decision: mixed case',
    { verb: 'needs-decision', text: 'mixed case' },
  ],
  ['  \n  done:   padded  ', { verb: 'done', text: 'padded' }],
  ['done: first\nblocked: second', { verb: 'done', text: 'first' }],
  ['done:', { verb: 'done', text: '' }],
  ['working on the parser', null],
  ['I am done: really', null],
  ['first line\ndone: second line', null],
  ['undone: x', null],
  ['', null],
  [undefined, null],
];

for (const [input, want] of cases) {
  test(`parseStatusLine(${JSON.stringify(input)})`, () => {
    assert.deepEqual(parseStatusLine(input), want);
  });
}
