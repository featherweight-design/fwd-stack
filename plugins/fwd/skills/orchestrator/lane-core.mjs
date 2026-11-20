// What lane-context.mjs reads out of a session transcript, kept pure so it is testable.
//
// A session's context is what its NEXT turn will re-read: the last assistant turn's input plus
// cache reads plus cache writes. Per-turn context size, not session length, drives cost.

import { resolve } from 'node:path';

/**
 * Claude Code's folder name for a project's transcripts: every non-alphanumeric of the ABSOLUTE
 * path becomes `-`. Resolved first, so `.` or a trailing slash names the same folder as the cwd.
 */
export const projectDirName = (path) =>
  resolve(path).replace(/[^A-Za-z0-9]/g, '-');

export function sessionSummary(jsonl) {
  // The latest of each: a session renamed twice shows its current name. A lane's agent name, when
  // it has one, wins over a title.
  let agentName = null;
  let title = null;
  let model = null;
  let context = null;
  let at = null;
  for (const line of jsonl.split('\n')) {
    if (!line) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // a partial first line from a tail read, or a line being written
    }
    if (e.type === 'agent-name' && e.agentName) agentName = e.agentName;
    else if (e.type === 'custom-title' && e.customTitle) title = e.customTitle;
    // A subagent's turns are written to the same transcript; they do not grow this session.
    if (e.type !== 'assistant' || e.isSidechain) continue;
    const u = e.message?.usage;
    if (!u) continue;
    context =
      (u.input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0);
    model = e.message.model ?? model;
    at = e.timestamp ?? at;
  }
  return { name: agentName ?? title, agentName, title, model, context, at };
}

/**
 * A lane's name from a transcript read in two windows. The tail holds the latest title and usage,
 * but a lane's agent name is written once, at its start, and a long transcript pushes it out of the
 * tail. So an agent name from either window wins, then the tail's title. The head's title is never
 * used: a later rename can sit between the two windows, and the head's would be the superseded one.
 */
export function laneName(tailSummary, headSummary = {}) {
  return (
    tailSummary.agentName ?? headSummary.agentName ?? tailSummary.title ?? null
  );
}

/**
 * What to do about a lane. The harness compacts every session at its configured window
 * (`autoCompactWindow`, 300k recommended; `sessionBudget.compactWindow` tells the kit what it is),
 * so size alone is no reason to rotate: rotation is for a lane that has compacted several times and
 * drifts, judged by its work, day or night. A lane past the window means compaction is due, or
 * this machine compacts later than the kit expects. `rotateAt` is an optional hard ceiling, off
 * by default; while the user is away it never stops a lane, and the rotation waits for their
 * return.
 */
export function verdict(
  context,
  { rotateAt = null, compactWindow = 300_000, away = false } = {},
) {
  if (context === null) return 'no turns yet';
  if (rotateAt !== null && context >= rotateAt)
    return away
      ? 'over rotateAt: keep working, turns lean, handoff at each PR boundary; rotate on return'
      : 'over rotateAt: rotate at its next PR boundary';
  if (context >= compactWindow)
    return 'past the compact window: compaction due; if it stays here, check autoCompactWindow';
  return 'ok';
}
