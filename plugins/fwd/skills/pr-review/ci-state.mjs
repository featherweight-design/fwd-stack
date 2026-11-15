// What the head's CI says, as problems. Pure: pr-gate.mjs hands it the check-runs, the legacy
// commit statuses and the workflow runs it fetched, so the rule is testable without the API.
//
// Two holes this closes (one PR: MERGE ALLOWED with "0 check(s) green" while CI was queued):
//  - A head with NO checks at all is not green. Between a push and Actions registering its runs
//    there are zero check-runs, and an empty set passed every loop below it.
//  - A queued re-run has no `started_at`, so choosing the newest run by `started_at` kept the OLD
//    completed run and hid the queued one. The newest run of a name is the higher id.
const OK = new Set(['success', 'neutral', 'skipped']);

// Copilot's own review runs as a workflow on the head. It is the review, not CI: while a round
// is in progress it would block a merge the watcher has already reported green (pr-watch.mjs
// leaves it out by the same test). Matched on the reviewer's exact identity, never a substring.
export const isReviewerRun = (w) =>
  /^Running Copilot Code Review$/i.test(w.name ?? '') ||
  /(^|\/)copilot-pull-request-reviewer$/.test(w.path ?? '');
// The reviewer's own check-run name. Anything else with "copilot" in it (a project's
// "Copilot integration tests") is ordinary CI and still gates the merge.
const isReviewerCheck = (name) => name === 'copilot-pull-request-reviewer';

export function ciProblemsOf({ runs, statuses, workflowRuns = [] }) {
  const problems = [];
  const reviewerSuites = new Set(
    workflowRuns.filter(isReviewerRun).map((w) => w.check_suite_id),
  );
  const newest = new Map();
  for (const r of runs) {
    if (reviewerSuites.has(r.check_suite?.id) || isReviewerCheck(r.name))
      continue;
    const prev = newest.get(r.name);
    if (!prev || r.id > prev.id) newest.set(r.name, r);
  }
  for (const r of newest.values()) {
    if (r.status !== 'completed') problems.push(`${r.name}: ${r.status}`);
    else if (!OK.has(r.conclusion)) problems.push(`${r.name}: ${r.conclusion}`);
  }
  const seen = new Set();
  for (const s of statuses) {
    if (seen.has(s.context)) continue;
    seen.add(s.context);
    if (s.state !== 'success') problems.push(`${s.context}: ${s.state}`);
  }
  // A workflow run that has not finished may not have registered every check-run yet.
  for (const w of workflowRuns) {
    if (isReviewerRun(w)) continue;
    if (w.status !== 'completed')
      problems.push(`workflow ${w.name}: ${w.status}`);
  }
  const count = newest.size + seen.size;
  if (count === 0)
    problems.push(
      'no checks on this head yet (CI not registered or still queued)',
    );
  else if (
    problems.length === 0 &&
    ![...newest.values()].some((r) => r.conclusion === 'success') &&
    !statuses.some((s) => s.state === 'success')
  )
    problems.push(
      'CI not run on this head: every check was skipped or neutral (push again or re-run CI)',
    );
  return { problems, count };
}
