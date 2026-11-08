#!/usr/bin/env node
// Warn as a session's context grows. Every turn re-reads the whole context, so the cost of a turn
// rises with its size: a turn at 300k tokens costs about ten times one at 30k. The size is read
// from the last turn's usage in the transcript, not counted in turns.
//
// Two events run it:
//   UserPromptSubmit: on every prompt over the warning line. The text goes into the model's context,
//     not onto the user's screen, so it tells the model what to suggest.
//   PostToolUse: once per band crossed (the warning line, the critical line, then every 100k
//     above it), so a session running unattended, which sees no user prompt for hours, is told too.
//
// Lines: `sessionBudget.warnTokens` (default 150k) and `orchestrator.rotateAt` (default 450k),
// the same line the orchestrator rotates lanes at. While the user is away (lib/away.mjs) both lines
// tell a session to keep working: the rotation line does not apply, nobody is there to restart it,
// and the harness compacts context on its own.
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { awayUntil } from '../lib/away.mjs';
import { isMain } from '../lib/is-main.mjs';
import { loadConfig } from '../lib/fwd-config.mjs';
import { pluginDataDir } from '../lib/plugin-data.mjs';
import { sessionSummary } from '../skills/orchestrator/lane-core.mjs';

const STEP = 100_000;

export function lines(config = {}) {
  const critical = config.orchestrator?.rotateAt ?? 450_000;
  // A rotation line set below the warning line still warns at it: the warning never comes later.
  const warn = Math.min(config.sessionBudget?.warnTokens ?? 150_000, critical);
  return { warn, critical };
}

// 0 below the warning line, 1 between the lines, then 2, 3, … for each 100k past the critical line.
export function band(context, { warn, critical }) {
  if (context === null || context < warn) return 0;
  if (context < critical) return 1;
  return 2 + Math.floor((context - critical) / STEP);
}

const k = (n) => `${Math.round(n / 1000)}k`;

export function budgetMessage(context, { warn, critical }, away = false) {
  if (context === null || context < warn) return null;
  if (away)
    return `[SESSION BUDGET — USER AWAY] This session's context is ~${k(context)} tokens. The user is away, so keep working: the ${k(critical)} rotation line does not apply while they are away, and the harness compacts context automatically. Never stop, or ask to stop, for context, even when the next PR looks too big to fit. Keep turns lean and write your handoff at each PR boundary.`;
  if (context >= critical)
    return `[SESSION BUDGET CRITICAL] This session's context is ~${k(context)} tokens, past the ${k(critical)} rotation line, and every turn re-reads all of it. At your next PR boundary: as a lane, write your handoff and ask the orchestrator to rotate you; otherwise suggest the user run /compact or start a fresh session. Until then, keep reads tight.`;
  return `[SESSION BUDGET WARNING] This session's context is ~${k(context)} tokens (rotation at ${k(critical)}), and every turn re-reads all of it. Keep reads tight; plan to hand off or compact at the next natural boundary.`;
}

// The last usage record sits near the end; a long transcript runs to tens of megabytes, so read a
// tail window, doubling it when one large tool result pushed the record out.
export function lastContext(path) {
  const size = statSync(path).size;
  for (let len = 1024 * 1024; ; len *= 2) {
    const n = Math.min(size, len);
    const fd = openSync(path, 'r');
    const buf = Buffer.alloc(n);
    try {
      readSync(fd, buf, 0, n, size - n);
    } finally {
      closeSync(fd);
    }
    const { context } = sessionSummary(buf.toString('utf8'));
    if (context !== null || n >= size) return { context, size };
  }
}

// One marker file per band announced to a session. Creating it with `wx` is atomic, so parallel
// tool calls (each its own hook process) announce a band once between them. A drop, after
// /compact, removes the markers above it, so growing back past a line warns again. Each marker
// holds the transcript's size when it was written, and a drop removes only markers written from a
// shorter transcript than its own reading: a delayed hook holding an older reading cannot undo a
// newer one. The transcript only grows (compaction appends), so its size orders the readings.
// Away and present keep separate markers, because the message for a band differs between them. A
// session announced a band in one mode is told again when the mode changes, and switching mode
// drops the other mode's markers, so switching back announces afresh too.
const stateDir = (sessionId, env, away = false) =>
  join(
    pluginDataDir(env),
    'session-budget',
    sessionId.replace(/[^\w-]/g, '_') + (away ? '.away' : ''),
  );

export function crossed(sessionId, now, seen, env = process.env, away = false) {
  rmSync(stateDir(sessionId, env, !away), { recursive: true, force: true });
  const dir = stateDir(sessionId, env, away);
  try {
    return announce(dir, now, seen);
  } catch (error) {
    // A hook in the other mode removed this folder meanwhile: the mode just changed, and the
    // hooks running in the new mode do the announcing. Drop this one.
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function announce(dir, now, seen) {
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) {
    if (!(Number(f) > now)) continue;
    let at = Infinity;
    try {
      at = Number(readFileSync(join(dir, f), 'utf8'));
    } catch {
      continue; // removed by another hook meanwhile
    }
    if (at < seen) rmSync(join(dir, f), { force: true });
  }
  if (now === 0) return false;
  try {
    writeFileSync(join(dir, String(now)), String(seen), { flag: 'wx' });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

// Run as a hook, not when a test imports it.
if (isMain(import.meta.url)) {
  let payload = {};
  try {
    payload = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0);
  }
  let context = null;
  let size = 0;
  try {
    ({ context, size } = lastContext(payload.transcript_path ?? ''));
  } catch {
    process.exit(0);
  }
  const l = lines(loadConfig());
  const away = awayUntil() !== null;
  const message = budgetMessage(context, l, away);
  if (payload.hook_event_name === 'PostToolUse') {
    // Recorded below the warning line too, so a session compacted back under it warns again.
    if (
      !payload.session_id ||
      !crossed(payload.session_id, band(context, l), size, process.env, away)
    )
      process.exit(0);
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: message,
        },
      }),
    );
  } else if (message) {
    console.log(message);
  }
}
