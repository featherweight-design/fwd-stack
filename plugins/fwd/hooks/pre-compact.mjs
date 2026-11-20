#!/usr/bin/env node
// PreCompact: steer the compaction summary so a lane or orchestrator keeps working after it.
//
// Claude Code uses a PreCompact hook's stdout, on exit 0, as instructions for the compaction
// summary (capped at 10,000 characters per hook). This hook never blocks: it prints what the
// summary must keep, plus the facts it can read for itself (the away window, this session's
// autonomous-run guard, the background commands still due to wake it), and always exits 0.
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { awayUntil } from '../lib/away.mjs';
import { isMain } from '../lib/is-main.mjs';
import { pendingWakes } from './background-waits.mjs';

const CAP = 9_000;

export const KEEP = [
  "The session's role: lane or orchestrator, its lane id and area, and the orchestrator session's name; or that it is neither.",
  'The brief: what and why, out of scope, the stop-and-report conditions, the STANDING RULES list word for word, the MODEL line and the stopping point.',
  'Every open PR: number, branch, worktree path, and where it stands (CI, review, what is owed next).',
  'Every background watcher, Monitor or scheduled wake still running: its id and what event it waits on.',
  'The away window and the autonomous-run guard: open or closed, until when, and the run description.',
  'The path of the handoff file, and of any plan or notes file in use.',
  'The exact next step, as a command or action, and anything a fresh reader would get wrong.',
];

const tail = (path, len = 4 * 1024 * 1024) => {
  const size = statSync(path).size;
  const n = Math.min(size, len);
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, size - n);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
};

/** The guard sentinel autonomous-guard.mjs writes for this session, or null. */
export function guardState(sessionId, env = process.env, home = homedir()) {
  if (!sessionId) return null;
  const dir = join(
    env.CLAUDE_CONFIG_DIR || join(home, '.claude'),
    'autonomous',
  );
  try {
    const state = JSON.parse(
      readFileSync(
        join(dir, `${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_')}.json`),
        'utf8',
      ),
    );
    return state?.armed ? state : null;
  } catch {
    return null;
  }
}

const iso = (ms) => new Date(ms).toISOString();

export function instructions({
  away = null,
  guard = null,
  tasks = [],
  now = Date.now(),
} = {}) {
  const facts = [
    away
      ? `The user is AWAY until ${iso(away)}: never stop, or ask to stop, for context.`
      : 'The away window is closed: the user is present.',
    guard
      ? `The autonomous-run guard is ARMED until ${iso(guard.expiresAt)} (${guard.count ?? 0}/${guard.max} continuations): "${String(guard.reason).slice(0, 400)}"`
      : 'The autonomous-run guard is not armed for this session.',
    tasks.length
      ? `Background commands still due to wake this session: ${tasks.join(', ')}. Keep what each waits on.`
      : 'No background command is recorded as still running.',
  ];
  const text = [
    'Compaction instructions (fwd PreCompact hook). This session keeps working after the summary, so keep, verbatim where it is a rule, a path or an id:',
    ...KEEP.map((k) => `- ${k}`),
    '',
    `Facts read at compaction (${iso(now)}); carry them into the summary:`,
    ...facts.map((f) => `- ${f}`),
    '',
    'Drop file contents, diffs and tool output already acted on; keep their conclusions and paths.',
  ].join('\n');
  return text.length > CAP ? text.slice(0, CAP) : text;
}

if (isMain(import.meta.url)) {
  let payload = {};
  try {
    payload = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    // An unreadable payload still gets the standing instructions.
  }
  let tasks = [];
  try {
    if (payload.transcript_path)
      ({ tasks } = pendingWakes(tail(payload.transcript_path), Date.now()));
  } catch {
    // No transcript: no watchers to list.
  }
  try {
    process.stdout.write(
      instructions({
        away: awayUntil(),
        guard: guardState(payload.session_id),
        tasks,
      }) + '\n',
    );
  } catch {
    // Never block compaction: exit 0 whatever happened.
  }
  process.exit(0);
}
