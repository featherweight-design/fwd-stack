// What a PR watcher reports, decided from one snapshot of the PR and what it has already reported.
//
// The state is the set of things already said, never a count taken once, so a watcher outlives a
// push: a head's CI is reported once all of its runs have completed, and the PR merging or closing
// is the last event.
// A snapshot is { state: "open" | "closed" | "merged", head, ciRuns: [{ head_sha, status, conclusion, name }] }.

export function initialState() {
  return { ci: new Set(), ended: false };
}

/** Mark everything already in `snap` as reported, so a watcher armed mid-PR wakes only on what comes next. */
export function primeState(snap) {
  const state = initialState();
  if (ciDone(snap)) state.ci.add(snap.head);
  return state;
}

function ciDone(snap) {
  const runs = snap.ciRuns.filter((r) => r.head_sha === snap.head);
  return runs.length > 0 && runs.every((r) => r.status === 'completed');
}

/** The events this snapshot adds, and the state after reporting them. Pure: `state` is not modified. */
export function watchStep(prev, snap) {
  const state = { ci: new Set(prev.ci), ended: prev.ended };
  const events = [];
  if (state.ended) return { state, events };
  if (!state.ci.has(snap.head) && ciDone(snap)) {
    state.ci.add(snap.head);
    const runs = snap.ciRuns.filter((r) => r.head_sha === snap.head);
    const failed = runs.filter(
      (r) => !['success', 'skipped', 'neutral'].includes(r.conclusion ?? ''),
    );
    events.push({
      type: 'ci',
      head: snap.head,
      ok: failed.length === 0,
      failed: failed.map((r) => r.name),
    });
  }
  if (snap.state !== 'open') {
    state.ended = true;
    events.push({ type: 'end', state: snap.state });
  }
  return { state, events };
}

/** One line per event, the line a Monitor notification shows. */
export function describe(pr, e) {
  const s = (sha) => (sha ?? '').slice(0, 7);
  if (e.type === 'ci')
    return e.ok
      ? `#${pr} CI passed on ${s(e.head)}`
      : `#${pr} CI FAILED on ${s(e.head)}: ${e.failed.join(', ')}`;
  return `#${pr} is ${e.state}: watcher done`;
}

// Whether another sleep-then-read cycle still ends before the deadline. The deadline is counted
// from process start, priming included, and a cycle is the sleep plus up to `readMs` of API calls:
// a loop that only checked the clock before sleeping could start its last cycle at 28:59 and print
// TIMED OUT after Monitor's 30-minute cap had already killed it, which is a silent exit.
export const fitsAnotherPoll = (now, deadline, intervalMs, readMs = 30_000) =>
  now + intervalMs + readMs <= deadline;
