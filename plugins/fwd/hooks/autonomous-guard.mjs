#!/usr/bin/env node
// Autonomous-run guard.
//
// THE PROBLEM IT SOLVES: a turn ends whenever the model stops emitting tool calls.
// "Work autonomously, don't stop" is a prompt-level instruction with no enforcement —
// so an agent can intend to continue and still stop, because stopping is the harness's
// default state rather than an action anyone takes. Runs died silently that way: a
// milestone got reported, nothing was in flight to re-invoke the model, and hours passed.
//
// It also covers the second failure: a background command that dies without notifying.
// The wake signal never arrives, and the silence is indistinguishable from progress.
// This hook kicks the session instead of letting it sit.
//
// HOW: on Stop, if this session has an armed sentinel, return decision:"block" with the
// run's own reason. The model is re-invoked and re-reads its state. A session with a live
// background command or a due ScheduleWakeup stops freely and spends nothing
// (background-waits.mjs): its wake is already on the way.
//
// THREE RAILS, because a hook that can refuse to stop can also trap a session:
//   1. Opt-in per session — nothing happens without an armed sentinel for THIS session_id.
//   2. Wall-clock expiry — an armed run stops being armed on its own.
//   3. A continuation cap — counted per session, never reset by the hook.
// Any one of them firing disarms the run and allows the stop.
//
// CLI: arm <reason> [--minutes N] [--max N] --session ID | disarm --session ID | status --session ID
//      (`--flag N` or `--flag=N`; CLAUDE_SESSION_ID stands in for --session when set)

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { pendingWakes } from './background-waits.mjs';

// State lives in the Claude config folder, not beside this script: an installed plugin's folder is
// replaced on every update, and a sentinel lost mid-run is a run that silently stops.
const DIR = join(
  process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
  'autonomous',
);
const SELF = fileURLToPath(import.meta.url);
const file = (sid) =>
  join(DIR, `${String(sid).replace(/[^A-Za-z0-9_-]/g, '_')}.json`);

const read = (sid) => {
  try {
    return JSON.parse(readFileSync(file(sid), 'utf8'));
  } catch {
    return null;
  }
};
const write = (sid, state) => {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(file(sid), JSON.stringify(state, null, 2));
};
const clear = (sid) => {
  try {
    rmSync(file(sid));
  } catch {
    // Already gone.
  }
};

const [cmd, ...rest] = process.argv.slice(2);

// ---- CLI surface, for the agent to arm and disarm its own run -------------------
if (cmd === 'arm' || cmd === 'disarm' || cmd === 'status') {
  // `--flag value` or `--flag=value`; every other word is the run's description.
  const flags = {};
  const words = [];
  for (let i = 0; i < rest.length; i++) {
    const m = rest[i].match(/^--(session|minutes|max)(?:=(.*))?$/);
    if (!m) words.push(rest[i]);
    else if (m[2] !== undefined) flags[m[1]] = m[2];
    // A flag with no value refuses rather than arming on the default: `--max` at the end of the
    // line, or followed by another flag, is an incomplete safety limit.
    else if (i + 1 >= rest.length || rest[i + 1].startsWith('--')) {
      console.error(`--${m[1]} needs a value`);
      process.exit(2);
    } else flags[m[1]] = rest[++i];
  }
  // An explicit flag wins: the variable stands in for it, and must not redirect a `disarm --session`.
  const sid = flags.session || process.env.CLAUDE_SESSION_ID;
  if (!sid) {
    console.error(
      'no session id: pass --session=<id> or set CLAUDE_SESSION_ID',
    );
    process.exit(2);
  }
  if (cmd === 'disarm') {
    clear(sid);
    console.log('disarmed');
    process.exit(0);
  }
  if (cmd === 'status') {
    console.log(JSON.stringify(read(sid) ?? { armed: false }, null, 2));
    process.exit(0);
  }
  // A value that is not a positive number refuses to arm: "armed for NaNm" wrote a run the
  // hook released on its first stop, while the agent believed it was guarded.
  const positive = (name, dflt) => {
    if (flags[name] === undefined) return dflt;
    const n = Number(flags[name]);
    if (!Number.isFinite(n) || n <= 0) {
      console.error(
        `--${name} must be a positive number, got "${flags[name]}"`,
      );
      process.exit(2);
    }
    return n;
  };
  const minutes = positive('minutes', 120);
  const max = positive('max', 40);
  const reason = words.join(' ') || 'Autonomous run in progress.';
  write(sid, {
    armed: true,
    reason,
    count: 0,
    max,
    expiresAt: Date.now() + minutes * 60_000,
  });
  console.log(`armed for ${minutes}m, max ${max} continuations`);
  process.exit(0);
}

// ---- Hook path: stdin is the Stop payload ---------------------------------------
let raw = '';
try {
  raw = readFileSync(0, 'utf8');
} catch {
  // No stdin: not a hook call.
}
let payload = {};
try {
  payload = JSON.parse(raw || '{}');
} catch {
  // Unreadable payload: behave as an ordinary session.
}
const sid = payload.session_id;

// No session id, or no sentinel for it: this is an ordinary session. Say nothing.
if (!sid) process.exit(0);
const state = read(sid);
if (!state?.armed) process.exit(0);

// `stop_hook_active` is NOT a reason to let the stop through. It is set on every stop that follows
// a block, so honouring it gave an armed run exactly one extra turn and made the continuation cap
// unreachable. The cap and the expiry below are what end a run.

const disarm = (why) => {
  clear(sid);
  console.log(
    JSON.stringify({ systemMessage: `Autonomous guard released: ${why}` }),
  );
  process.exit(0);
};

if (Date.now() > state.expiresAt) disarm("the run's time window expired");
if (state.count >= state.max) disarm(`hit its ${state.max}-continuation cap`);

// A session waiting on a background command or a due ScheduleWakeup is already doing the right
// thing: the wake is coming. Let it stop, and spend no continuation. Blocking it re-invoked the
// model every few seconds with nothing to do and drained the cap inside one CI wait.
let transcript = '';
try {
  transcript = payload.transcript_path
    ? readFileSync(payload.transcript_path, 'utf8')
    : '';
} catch {
  // Unreadable transcript: fall through to the ordinary block.
}
const wakes = pendingWakes(transcript, Date.now());
if (wakes.tasks.length || wakes.wakeUntil) process.exit(0);

state.count += 1;
write(sid, state);

// Kept to ONE short line on purpose: the harness prints the reason in the terminal on every
// block, and the full run description plus instructions made each idle wake a paragraph of
// noise (2026-09-28). The run's own description is still on disk (`status`), and the
// line below is enough to act on. `suppressOutput` hides what the harness allows it to.
const left = state.max - state.count;
console.log(
  JSON.stringify({
    decision: 'block',
    suppressOutput: true,
    reason:
      `Autonomous run armed (${left} left): take the next action, or disarm ` +
      `(\`node "${SELF}" disarm --session=${sid}\`) if the run is done. ` +
      `Run: ${state.reason.slice(0, 80)}${state.reason.length > 80 ? '…' : ''}`,
  }),
);
