// node --test ci-state.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ciProblemsOf } from './ci-state.mjs';

const run = (id, name, status, conclusion = null, started_at = null) => ({
  id,
  name,
  status,
  conclusion,
  started_at,
});

test('a head with no checks at all is a problem, not a green', () => {
  const { problems, count } = ciProblemsOf({ runs: [], statuses: [] });
  assert.equal(count, 0);
  assert.match(problems.join(), /no checks on this head/);
});

test('a head whose only checks were skipped is CI not run, not green', () => {
  const { problems, count } = ciProblemsOf({
    runs: [run(1, 'dependabot-automerge', 'completed', 'skipped')],
    statuses: [],
    workflowRuns: [{ name: 'Dependabot auto-merge', status: 'completed' }],
  });
  assert.equal(count, 1);
  assert.match(problems.join(), /CI not run on this head/);
});

test('a conflicting PR says rebase, first', () => {
  const { problems } = ciProblemsOf({
    runs: [run(1, 'dependabot-automerge', 'completed', 'skipped')],
    statuses: [],
    mergeableState: 'dirty',
  });
  assert.match(problems[0], /^conflicts with base: rebase/);
});

test('unknown mergeability with no CI run adds the rebase hint', () => {
  const { problems } = ciProblemsOf({
    runs: [],
    statuses: [],
    mergeableState: 'unknown',
  });
  assert.match(problems.join(), /no checks on this head/);
  assert.match(problems.join(), /mergeability unknown/);
});

test('unknown mergeability with green CI is not a problem', () => {
  const { problems } = ciProblemsOf({
    runs: [run(1, 'test', 'completed', 'success')],
    statuses: [],
    mergeableState: 'unknown',
  });
  assert.deepEqual(problems, []);
});

test('a queued check blocks', () => {
  const { problems } = ciProblemsOf({
    runs: [run(2, 'test', 'queued')],
    statuses: [],
  });
  assert.deepEqual(problems, ['test: queued']);
});

test('a queued re-run hides the old completed run: the higher id wins, not started_at', () => {
  const { problems } = ciProblemsOf({
    runs: [
      run(1, 'test', 'completed', 'success', '2026-10-22T10:00:00Z'),
      run(2, 'test', 'queued'),
    ],
    statuses: [],
  });
  assert.deepEqual(problems, ['test: queued']);
});

test('an unfinished workflow run blocks even when its check-runs have not registered', () => {
  const { problems } = ciProblemsOf({
    runs: [run(1, 'select', 'completed', 'success')],
    statuses: [],
    workflowRuns: [{ name: 'CI', status: 'queued' }],
  });
  assert.deepEqual(problems, ['workflow CI: queued']);
});

test('all green passes and counts', () => {
  const r = ciProblemsOf({
    runs: [
      run(1, 'test', 'completed', 'success'),
      run(2, 'lint', 'completed', 'skipped'),
    ],
    statuses: [{ context: 'vercel', state: 'success' }],
    workflowRuns: [{ name: 'CI', status: 'completed' }],
  });
  assert.deepEqual(r, { problems: [], count: 3 });
});

test('a failed check and a pending status both block', () => {
  const { problems } = ciProblemsOf({
    runs: [run(1, 'test', 'completed', 'failure')],
    statuses: [{ context: 'vercel', state: 'pending' }],
  });
  assert.deepEqual(problems, ['test: failure', 'vercel: pending']);
});

test('a Copilot review in progress is the review, not CI, and does not block', () => {
  const { problems, count } = ciProblemsOf({
    runs: [
      {
        ...run(1, 'gate / gate', 'completed', 'success'),
        check_suite: { id: 10 },
      },
      {
        ...run(2, 'copilot-pull-request-reviewer', 'in_progress'),
        check_suite: { id: 20 },
      },
    ],
    statuses: [],
    workflowRuns: [
      { name: 'CI', status: 'completed', check_suite_id: 10 },
      {
        name: 'Running Copilot Code Review',
        path: 'dynamic/agents/copilot-pull-request-reviewer',
        status: 'in_progress',
        check_suite_id: 20,
      },
    ],
  });
  assert.deepEqual(problems, []);
  assert.equal(count, 1);
});

test('a real CI workflow still blocks while it runs', () => {
  const { problems } = ciProblemsOf({
    runs: [
      { ...run(1, 'gate / gate', 'in_progress'), check_suite: { id: 10 } },
    ],
    statuses: [],
    workflowRuns: [{ name: 'CI', status: 'in_progress', check_suite_id: 10 }],
  });
  assert.deepEqual(problems, [
    'gate / gate: in_progress',
    'workflow CI: in_progress',
  ]);
});

test('a project check that merely mentions Copilot is CI and still blocks', () => {
  const { problems } = ciProblemsOf({
    runs: [
      {
        ...run(1, 'Copilot integration tests', 'completed', 'failure'),
        check_suite: { id: 30 },
      },
    ],
    statuses: [],
    workflowRuns: [
      {
        name: 'CI',
        path: '.github/workflows/copilot-tests.yml',
        status: 'completed',
        check_suite_id: 30,
      },
    ],
  });
  assert.deepEqual(problems, ['Copilot integration tests: failure']);
});
