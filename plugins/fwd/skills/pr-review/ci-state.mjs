// What the head's CI says, as problems. Pure: pr-gate.mjs hands it the check-runs, the legacy
// commit statuses and the workflow runs it fetched, so the rule is testable without the API.
//
// Two holes this closes (one PR: MERGE ALLOWED with "0 check(s) green" while CI was queued):
//  - A head with NO checks at all is not green. Between a push and Actions registering its runs
//    there are zero check-runs, and an empty set passed every loop below it.
//  - A queued re-run has no `started_at`, so choosing the newest run by `started_at` kept the OLD
//    completed run and hid the queued one. The newest run of a name is the higher id.
const OK = new Set(['success', 'neutral', 'skipped']);

// `mergeableState` is the REST pull's `mergeable_state`. GitHub runs no pull_request CI on a PR
// that conflicts with its base, so a conflict shows up only as missing or skipped checks; name it.
export function ciProblemsOf({
  runs,
  statuses,
  workflowRuns = [],
  mergeableState,
}) {
  const problems = [];
  if (mergeableState === 'dirty')
    problems.push(
      'conflicts with base: rebase onto the base branch and push (no pull_request CI runs on a conflicting PR)',
    );
  const newest = new Map();
  for (const r of runs) {
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
  if (
    mergeableState === 'unknown' &&
    problems.some((p) => /^(no checks|CI not run)/.test(p))
  )
    problems.push(
      'mergeability unknown: if the PR conflicts with its base, rebase and push',
    );
  return { problems, count };
}
