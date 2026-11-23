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
  // Deliberate: a red check is not news until every check has finished, so pending wins first.
  if (!rollup.every(done)) return 'pending';
  return rollup.some((c) => FAILED.has(result(c))) ? 'failure' : 'success';
}

// Talk from the user's own login or a [bot] author is not news to the orchestrator.
const fromOthers = (me) => (x) => {
  const login = (x?.author?.login ?? '').toLowerCase();
  return !login.endsWith('[bot]') && (!me || login !== me.toLowerCase());
};

/**
 * What a poll remembers about each open PR, by number. `talk` counts reviews plus comments by
 * anyone but `me` and bots. Drafts and held PRs get no snapshot, so they raise no events.
 */
export function snapshots(prs, me = null) {
  return Object.fromEntries(
    prs
      .filter((p) => !p.isDraft && !held(p))
      .map((p) => [
        p.number,
        {
          title: p.title,
          checks: checksState(p.statusCheckRollup),
          talk:
            (p.reviews ?? []).filter(fromOthers(me)).length +
            (p.comments ?? []).filter(fromOthers(me)).length,
        },
      ]),
  );
}

export const MAX_MISS = 5;
export const MAX_LOOKUPS = 5;

/** The remembered PRs missing from the open list to look up this poll, the fewest misses first. */
export function lookupBatch(prev = {}, open = [], cap = MAX_LOOKUPS) {
  const isOpen = new Set(open.map(String));
  return Object.keys(prev)
    .filter((n) => !isOpen.has(n))
    .sort((a, b) => (prev[a].miss ?? 0) - (prev[b].miss ?? 0))
    .slice(0, cap);
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

/**
 * The snapshots to store: the open PRs, plus those not seen this poll. A PR in `tried` (looked up
 * as gone) that came back unresolved gains a `miss`, and is dropped after MAX_MISS of them so a
 * lookup that never resolves is not retried forever.
 */
export function nextSnapshots(prev = {}, cur = {}, resolved = {}, tried = []) {
  const out = {};
  for (const [n, was] of Object.entries(prev)) {
    if (cur[n] || resolved[n]) continue;
    if (!tried.map(String).includes(n)) out[n] = was;
    else if ((was.miss ?? 0) + 1 < MAX_MISS)
      out[n] = { ...was, miss: (was.miss ?? 0) + 1 };
  }
  return { ...out, ...cur };
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

/** The class of a poll wake: event, then quiet, then the timer alone. Errors are reported directly. */
export function wakeClass({ events = [], stalled = [] } = {}) {
  if (events.length) return 'event';
  return stalled.length ? 'quiet' : 'heartbeat';
}
