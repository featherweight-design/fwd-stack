#!/usr/bin/env node
// Warn as a session's context grows. Every turn re-reads the whole context, so the cost of a turn
// rises with its size: a turn at 300k tokens costs about ten times one at 30k. The size is read
// from the last turn's usage in the transcript, not counted in turns.
//
// Two events run it:
//   UserPromptSubmit: the text goes into the model's context, not onto the user's screen, so it
//     tells the model what to suggest.
//   PostToolUse: the same message, so a session running unattended, which sees no user prompt for
//     hours, is told too.
// Either event speaks only when the context first crosses a 50k step at or above the warning line
// (150k, 200k, 250k, ...), once per session across both events; state lives in the plugin's data
// folder. A session that compacts back below a step is told again when it grows past it.
//
// Lines: `sessionBudget.warnTokens` (default 150k) and `sessionBudget.compactWindow` (default
// 300k), the window the harness compacts at when the machine sets the recommended
// `"autoCompactWindow": 300000`. Neither line asks for a rotation: a session past the window has
// compaction due, or a machine that compacts later than the kit expects. A project that sets
// `orchestrator.rotateAt` below the window gets that line instead, the one place size asks for a
// rotation, and only while the user is present. While the user is away (lib/away.mjs) the
// message adds that nothing stops for context.
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

const STEP = 50_000;

export function lines(config = {}) {
  const window = config.sessionBudget?.compactWindow ?? 300_000;
  // A project that sets `orchestrator.rotateAt` below the window keeps its line: the hook and
  // lane-context read the same ceiling.
  const rotateAt = config.orchestrator?.rotateAt ?? null;
  const critical = rotateAt !== null && rotateAt < window ? rotateAt : window;
  // A line set below the warning line still warns at it: the warning never comes later.
  const warn = Math.min(config.sessionBudget?.warnTokens ?? 150_000, critical);
  return { warn, critical, window };
}

// 0 below the warning line, then 1, 2, 3, … for each 50k step from the warning line, with one
// extra band at the upper line so crossing it is announced even between steps.
export function band(context, { warn, critical }) {
  if (context === null || context < warn) return 0;
  return (
    1 + Math.floor((context - warn) / STEP) + (context >= critical ? 1 : 0)
  );
}

const k = (n) => `${Math.round(n / 1000)}k`;

export function budgetMessage(
  context,
  { warn, critical, window = critical },
  away = false,
) {
  if (context === null || context < warn) return null;
  const lean =
    'Keep turns lean: read files in parts, hand broad searches to a subagent, and write your handoff at each PR boundary.';
  const rotate =
    'Rotate only if this session has compacted several times and drifts (forgets the brief, repeats work).';
  const stay = away
    ? ' The user is away: never stop, or ask to stop, for context, even when the next PR looks too big to fit.'
    : '';
  const past = context >= critical;
  const head = `[SESSION BUDGET${past ? (critical < window ? ' — PAST ROTATEAT' : ' — PAST THE COMPACT WINDOW') : ' WARNING'}${away ? ' — USER AWAY' : ''}]`;
  const where = !past
    ? `The harness compacts it at its configured window, ~${k(window)} on this kit's setup.`
    : critical < window
      ? `It is past this project's ${k(critical)} \`rotateAt\` line; ${away ? "that line waits for the user's return" : 'rotate at the next PR boundary'}. The harness compacts at ~${k(window)}.`
      : `It is past the ${k(window)} compact window, so compaction is due; if it does not come, this machine's \`autoCompactWindow\` is unset or higher (recommended: "autoCompactWindow": ${window} in ~/.claude/settings.json).`;
  return `${head} This session's context is ~${k(context)} tokens, and every turn re-reads all of it. ${where}${stay} ${lean}${past && critical < window ? '' : ` ${rotate}`}`;
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
  // Recorded below the warning line too, so a session compacted back under it warns again.
  if (
    !payload.session_id ||
    !crossed(payload.session_id, band(context, l), size, process.env, away)
  )
    process.exit(0);
  if (payload.hook_event_name === 'PostToolUse') {
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
