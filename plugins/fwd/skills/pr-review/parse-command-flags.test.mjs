// Which away-window flags a command line carries: --auto, --admin, queue and auto-merge mutations.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeFlags,
  parseCommand,
  queueMention,
  unreadableLine,
} from './parse-command.mjs';

test('--auto is reported on a merge, wherever it sits', () => {
  assert.deepEqual(parseCommand('gh pr merge 42 --auto --squash'), [
    { action: 'merge', pr: '42', repo: null, flags: ['auto'] },
  ]);
  assert.deepEqual(mergeFlags('gh pr merge --auto --squash 42'), ['auto']);
  assert.deepEqual(mergeFlags('gh pr merge 42 --auto=true'), ['auto']);
});

test('--admin is reported, and both together', () => {
  assert.deepEqual(mergeFlags('gh pr merge 42 --admin'), ['admin']);
  assert.deepEqual(mergeFlags('gh pr merge 42 --admin --auto'), [
    'admin',
    'auto',
  ]);
});

test('a plain merge carries no flags and reads exactly as before', () => {
  assert.deepEqual(parseCommand('gh pr merge 42 --squash'), [
    { action: 'merge', pr: '42', repo: null },
  ]);
  assert.deepEqual(mergeFlags('gh pr merge 42 --squash'), []);
});

test('--disable-auto is not a forbidden flag', () => {
  assert.deepEqual(mergeFlags('gh pr merge 42 --disable-auto'), []);
});

test('a flag spelling inside a flag value is text, not a flag', () => {
  assert.deepEqual(mergeFlags('gh pr merge 42 --body "--auto --admin"'), []);
  assert.deepEqual(mergeFlags('gh pr merge 42 --subject --admin'), []);
});

test('a flagged merge inside a shell wrapper is still read', () => {
  assert.deepEqual(mergeFlags("bash -c 'gh pr merge 42 --auto'"), ['auto']);
});

test('a short-flag cluster stays unreadable, so it is denied outright', () => {
  assert.equal(unreadableLine('gh pr merge 42 -sA'), true);
});

test('the GraphQL enqueue and auto-merge mutations read as queue', () => {
  assert.equal(
    queueMention(
      `gh api graphql -f query='mutation { enqueuePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }'`,
    ),
    true,
  );
  assert.deepEqual(
    mergeFlags(
      `gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {pullRequestId: "x"}) { clientMutationId } }'`,
    ),
    ['queue'],
  );
});

test('queue and a flagged merge in one line are both reported once', () => {
  assert.deepEqual(
    mergeFlags(
      `gh pr merge 42 --auto && gh api graphql -f query='mutation { enqueuePullRequest(input: {}) { x } }'`,
    ),
    ['auto', 'queue'],
  );
});

test('unrelated graphql and merge-free lines carry no flags', () => {
  assert.deepEqual(
    mergeFlags('gh api graphql -f query="{ viewer { login } }"'),
    [],
  );
  assert.deepEqual(mergeFlags('gh pr view 42'), []);
});
