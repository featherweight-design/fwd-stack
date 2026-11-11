#!/usr/bin/env node
// PreToolUse guard for Bash: denies a long wait run in the foreground. A foreground wait holds the
// turn, so the user's messages queue behind it; long waits belong in the background, where the
// completion notification wakes the session (orchestrator §6).
//
// A call made with `run_in_background: true` always passes. Otherwise it denies a command when
// any simple command in it is:
//
//   - `sleep` of 30 seconds or more (suffixes and several operands summed, as GNU sleep does);
//   - any `sleep` inside a `while`, `until`, `for` or `select` loop, however short;
//   - `gh run watch`, or any gh command with `--watch` (`gh pr checks --watch`);
//   - `tail -f`, `tail -F` or `tail --follow`;
//   - `watch <command>`, which repeats until interrupted.
//
// The command is split by secret-guard.mjs's parser (pipes, lists, newlines, subshells, `$(...)`,
// backticks), wrappers such as `timeout`, `nohup` and `xargs` are peeled off so the command they
// run is judged, and `bash -c`, `eval` and shell heredocs are parsed again. Quoted text is data, so
// `echo "sleep 60"` passes. A `sleep` whose length is not a literal (`sleep $N`) passes outside a
// loop. Any parse failure or unreadable input allows the call.
import { readFileSync } from 'node:fs';

import { isMain } from '../lib/is-main.mjs';
import {
  SHELLS,
  basename,
  isOption,
  parseCommands,
  unwrap,
} from './secret-guard.mjs';

// The longest foreground sleep allowed outside a loop, in seconds (exclusive).
export const SLEEP_LIMIT = 30;

const LOOP_START = new Set(['while', 'until', 'for', 'select']);
// Reserved words that may precede a loop keyword at the start of a simple command.
const LEADING = new Set(['if', 'then', 'else', 'elif', 'do', '!', '{', 'time']);
const UNIT = { '': 1, s: 1, m: 60, h: 3600, d: 86400 };
const isAssignment = (w) => /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(w);

const BACKGROUND =
  'Run long waits with `run_in_background` on the Bash tool (or with the Monitor tool) so the user can talk to the session; the completion notification wakes you.';

// The total seconds a `sleep` waits, or null when an operand is not a literal duration.
export function sleepSeconds(args) {
  const ops = args.filter((a) => a !== '--');
  if (!ops.length) return null;
  let total = 0;
  for (const a of ops) {
    if (/^inf(inity)?$/i.test(a)) return Infinity;
    const m = /^(\d+(?:\.\d*)?|\.\d+)([smhd]?)$/.exec(a);
    if (!m) return null;
    total += Number(m[1]) * UNIT[m[2]];
  }
  return total;
}

// How a segment's leading reserved words move the loop depth: +1 when it opens a loop, -1 when
// it is `done`, 0 otherwise.
function loopStep(words) {
  for (const w of words) {
    if (w === 'done') return -1;
    if (LOOP_START.has(w)) return 1;
    if (!LEADING.has(w) && !isAssignment(w)) return 0;
  }
  return 0;
}

// The words before the command a segment runs: assignments, reserved words and wrappers. Used to
// spot `watch`, which unwrap() turns into a nested command line.
function runsWatch(words) {
  for (const w of words) {
    if (isAssignment(w) || LEADING.has(w) || LOOP_START.has(w)) continue;
    const name = basename(w);
    if (name === 'watch') return true;
    if (!['nohup', 'nice', 'sudo', 'exec', 'builtin', 'command'].includes(name))
      return false;
  }
  return false;
}

// The reason one simple command (wrappers already peeled) is a long foreground wait, or null.
function judgeWords(words, inLoop) {
  if (!words.length) return null;
  const name = basename(words[0]);
  const args = words.slice(1);
  if (name === 'sleep') {
    if (args.some((a) => a === '--help' || a === '--version')) return null;
    if (inLoop) return '`sleep` inside a loop is a polling wait.';
    const s = sleepSeconds(args);
    return s !== null && s >= SLEEP_LIMIT
      ? `\`sleep ${args.join(' ')}\` waits ${SLEEP_LIMIT} seconds or more.`
      : null;
  }
  if (name === 'gh') {
    if (args.some((a) => a === '--watch' || a.startsWith('--watch=')))
      return '`gh … --watch` waits until the checks finish.';
    const pos = [];
    for (let k = 0; k < args.length; k++) {
      if (args[k] === '-R' || args[k] === '--repo') k++;
      else if (!isOption(args[k])) pos.push(args[k]);
    }
    if (pos[0] === 'run' && pos[1] === 'watch')
      return '`gh run watch` waits until the run finishes.';
    return null;
  }
  if (name === 'tail') {
    const follow = args.some(
      (a) =>
        a === '--follow' ||
        a.startsWith('--follow=') ||
        /^-[a-zA-Z]*[fF]/.test(a),
    );
    return follow ? '`tail -f` waits until interrupted.' : null;
  }
  return null;
}

function judgeSegment(seg, inLoop, depth) {
  if (runsWatch(seg.words)) return '`watch` repeats until interrupted.';
  const unwrapped = unwrap(seg.words);
  if (unwrapped.skip || unwrapped.envDump) return null;
  if (unwrapped.nested !== undefined)
    return judge(unwrapped.nested, inLoop, depth + 1);
  const words = unwrapped.words;
  if (!words.length) return null;
  const name = basename(words[0]);
  const args = words.slice(1);
  if (name === 'eval') return judge(args.join(' '), inLoop, depth + 1);
  if (SHELLS.has(name)) {
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(a))
        return k + 1 < args.length
          ? judge(args[k + 1], inLoop, depth + 1)
          : null;
      if (/^[-+][a-zA-Z]*[oO]$/.test(a)) k++;
      else if (!isOption(a) && !a.startsWith('+')) return null; // a script file
    }
    for (const body of seg.heredocs) {
      const r = judge(body, inLoop, depth + 1);
      if (r) return r;
    }
    for (const r of seg.redirects)
      if (r.op === '<<<') {
        const out = judge(r.target, inLoop, depth + 1);
        if (out) return out;
      }
    return null;
  }
  return judgeWords(words, inLoop);
}

function judge(command, inLoop = false, depth = 0) {
  if (depth > 8) return null;
  let loops = 0;
  for (const seg of parseCommands(command)) {
    const step = loopStep(seg.words);
    if (step > 0) loops++;
    // The loop's own condition (`while sleep 5`) runs on every pass, so it counts as inside.
    const reason = judgeSegment(seg, inLoop || loops > 0, depth);
    if (reason) return reason;
    if (step < 0 && loops > 0) loops--;
  }
  return null;
}

// Returns the denial message, or null when the call is allowed.
export function foregroundWaitDecision(command, runInBackground = false) {
  if (runInBackground === true) return null;
  if (typeof command !== 'string' || !command.trim()) return null;
  const reason = judge(command);
  return reason ? `${reason} ${BACKGROUND}` : null;
}

if (isMain(import.meta.url)) {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.exit(0);
  }
  if (input?.tool_name !== undefined && input.tool_name !== 'Bash')
    process.exit(0);
  let reason = null;
  try {
    reason = foregroundWaitDecision(
      input?.tool_input?.command,
      input?.tool_input?.run_in_background,
    );
  } catch {
    // A parser failure must never block work; this guard catches habits, it is not a sandbox.
    process.exit(0);
  }
  if (reason)
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `foreground-wait-guard: ${reason}`,
        },
      }),
    );
}
