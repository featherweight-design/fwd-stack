// Which open PRs have gone quiet, kept pure so it is testable. A PR is quiet when nothing has
// touched it (a push, a review, a comment) for `stallMinutes`: the sign a lane has stopped,
// or is waiting on something that will never notify it.

/**
 * The stalled PRs not already reported. `seen` maps a PR number to the `updatedAt` it was last
 * reported at: a PR still quiet since then has been handed to the orchestrator once, and reporting
 * it on every re-arm would end each watch on its first poll. Any new activity reports it again.
 */
export function unreported(stalled, seen = {}) {
  return stalled.filter((p) => seen[p.number] !== p.updatedAt);
}

// A PR held on purpose carries this label: it is not a lane that stopped.
export const HOLD_LABEL = 'hold';
export const held = (p) =>
  (p.labels ?? []).some((l) => (l?.name ?? l).toLowerCase() === HOLD_LABEL);

export function stalledPrs(prs, now, stallMinutes = 30) {
  return prs
    .filter((p) => !p.isDraft && !held(p))
    .map((p) => ({
      ...p,
      quietMinutes: Math.floor((now - Date.parse(p.updatedAt)) / 60_000),
    }))
    .filter((p) => p.quietMinutes >= stallMinutes)
    .sort((a, b) => b.quietMinutes - a.quietMinutes);
}

/** The open PRs held on purpose, the quietest first, so every report shows a hold left behind. */
export function heldPrs(prs, now) {
  return prs
    .filter((p) => !p.isDraft && held(p))
    .map((p) => ({
      ...p,
      quietMinutes: Math.floor((now - Date.parse(p.updatedAt)) / 60_000),
    }))
    .sort((a, b) => b.quietMinutes - a.quietMinutes);
}

// State transitions seen between two polls. The state file keeps one small snapshot per PR, and
// a wake reports what changed since the last one: checks finished, a merge, a close, new talk.

const FAILED = new Set([
  'FAILURE',
  'TIMED_OUT',
  'CANCELLED',
  'STARTUP_FAILURE',
  'ACTION_REQUIRED',
  'ERROR',
]);

/** One word for a PR's checks: none, pending, success or failure (pending wins until all finish). */
export function checksState(rollup = []) {
  if (!rollup?.length) return 'none';
  const result = (c) => (c.conclusion ?? c.state ?? '').toUpperCase();
  const done = (c) =>
    c.__typename === 'StatusContext'
      ? !['PENDING', 'EXPECTED', ''].includes(result(c))
      : (c.status ?? '').toUpperCase() === 'COMPLETED';
  if (!rollup.every(done)) return 'pending';
  return rollup.some((c) => FAILED.has(result(c))) ? 'failure' : 'success';
}

/** What a poll remembers about each open PR, by number. `talk` counts reviews plus comments. */
export function snapshots(prs) {
  return Object.fromEntries(
    prs.map((p) => [
      p.number,
      {
        title: p.title,
        checks: checksState(p.statusCheckRollup),
        talk: (p.reviews?.length ?? 0) + (p.comments?.length ?? 0),
      },
    ]),
  );
}

/**
 * The events between the previous snapshots and now. `cur` is the open PRs; `resolved` maps a
 * number that left the open list to 'merged' or 'closed' (absent when it could not be looked up,
 * so it is tried again next poll). A PR with no previous snapshot is a baseline, not an event.
 */
export function transitions(prev = {}, cur = {}, resolved = {}) {
  const events = [];
  for (const [n, was] of Object.entries(prev)) {
    const number = Number(n);
    const now = cur[n];
    if (!now) {
      if (resolved[n])
        events.push({ number, title: was.title, kind: resolved[n] });
      continue;
    }
    if (
      now.checks !== was.checks &&
      ['success', 'failure'].includes(now.checks)
    )
      events.push({
        number,
        title: now.title,
        kind: now.checks === 'success' ? 'checks-passed' : 'checks-failed',
      });
    if (now.talk > was.talk)
      events.push({ number, title: now.title, kind: 'new-talk' });
  }
  return events;
}

/** The snapshots to store: the open PRs, plus any that vanished without a lookup result. */
export function nextSnapshots(prev = {}, cur = {}, resolved = {}) {
  const keep = Object.entries(prev).filter(([n]) => !cur[n] && !resolved[n]);
  return { ...Object.fromEntries(keep), ...cur };
}

const WORDS = {
  'checks-passed': 'checks passed',
  'checks-failed': 'checks failed',
  merged: 'merged',
  closed: 'closed without merging',
  'new-talk': 'new review or comment',
};
export const describeEvent = (e) =>
  `  #${e.number} ${WORDS[e.kind]}: ${e.title}`;

/** The one class a wake carries: error, then event, then quiet, then the timer alone. */
export function wakeClass({ failed = false, events = [], stalled = [] } = {}) {
  if (failed) return 'error';
  if (events.length) return 'event';
  return stalled.length ? 'quiet' : 'heartbeat';
}
