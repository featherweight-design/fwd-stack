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
