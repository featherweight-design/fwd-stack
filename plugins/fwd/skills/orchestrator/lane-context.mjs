#!/usr/bin/env node
// Every recently active session in a project, with the context its next turn will re-read and
// what to do about it. Reads local transcripts only, so it costs no model tokens: the
// orchestrator runs it on every watchdog wake instead of measuring lanes by hand.
//
//   node lane-context.mjs [--project <dir>] [--active <minutes>] [--away] [--json]
//
// The compact window comes from `sessionBudget.compactWindow` in fwd.json (default 300k, matching
// the recommended `autoCompactWindow`); `orchestrator.rotateAt` is an optional ceiling, off by
// default. The user counts as away with `--away` or while the shared away window is open
// (lib/away.mjs).
import { openSync, readSync, closeSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

import { awayUntil } from '../../lib/away.mjs';
import { loadConfig } from '../../lib/fwd-config.mjs';
import {
  laneName,
  projectDirName,
  sessionSummary,
  verdict,
} from './lane-core.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const project = resolve(flag('project') ?? process.cwd());
const activeMinutes = Number(flag('active') ?? 120);
const away = args.includes('--away') || awayUntil() !== null;

const config = loadConfig({ ...process.env, CLAUDE_PROJECT_DIR: project });
const limits = {
  rotateAt: config.orchestrator?.rotateAt ?? null,
  compactWindow: config.sessionBudget?.compactWindow ?? 300_000,
  away,
};
const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
// A lane in a worktree writes its transcript under the worktree's path, not the project's, so
// every worktree of the repository is scanned too.
const worktrees = () => {
  try {
    return (
      execFileSync(
        'git',
        ['-C', project, 'worktree', 'list', '--porcelain', '-z'],
        {
          encoding: 'utf8',
          timeout: 10_000,
          stdio: ['ignore', 'pipe', 'ignore'], // not a repository: no worktrees, and no noise
        },
      )
        // -z: NUL-separated and unquoted. Plain porcelain quotes a path holding non-ASCII.
        .split('\0')
        .filter((l) => l.startsWith('worktree '))
        .map((l) => l.slice('worktree '.length))
    );
  } catch {
    return [];
  }
};
const dirs = [...new Set([project, ...worktrees()].map(projectDirName))].map(
  (name) => join(configDir, 'projects', name),
);

// The tail is usually enough for the last turn's usage and the latest title, and a long transcript
// runs to tens of megabytes. A lane's agent name is the exception: it is written once, at the
// start, so it is read from a separate head window when the tail has none (see summarize). One large tool result can push the last usage
// out of the window, so the window doubles until a usage record is in it or the file is read whole.
const TAIL = 4 * 1024 * 1024;
const HEAD = 1024 * 1024;
const slice = (path, start, n) => {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, start);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
};
const tail = (path, size, len) => {
  const n = Math.min(size, len);
  return slice(path, size - n, n);
};
const summarize = (path, size) => {
  for (let len = TAIL; ; len *= 2) {
    const s = sessionSummary(tail(path, size, len));
    if (s.context !== null || len >= size) {
      // The agent name is written at the start; read the head for it when the tail has none.
      const head =
        s.agentName || len >= size
          ? {}
          : sessionSummary(slice(path, 0, Math.min(size, HEAD)));
      return { ...s, name: laneName(s, head) };
    }
  }
};

const files = dirs.flatMap((dir) => {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f, path: join(dir, f) }));
  } catch {
    return [];
  }
});
if (files.length === 0) {
  console.error(`no transcripts for ${project} (looked in ${dirs.join(', ')})`);
  process.exit(1);
}
const since = Date.now() - activeMinutes * 60_000;
const lanes = files
  .map(({ f, path }) => ({ f, path, stat: statSync(path) }))
  .filter(({ stat }) => stat.mtimeMs >= since)
  .map(({ f, path, stat }) => {
    const s = summarize(path, stat.size);
    return {
      session: f.replace(/\.jsonl$/, ''),
      name: s.name ?? f.slice(0, 8),
      model: s.model,
      context: s.context,
      idleMinutes: Math.round((Date.now() - stat.mtimeMs) / 60_000),
      verdict: verdict(s.context, limits),
    };
  })
  .sort((a, b) => (b.context ?? 0) - (a.context ?? 0));

if (args.includes('--json')) {
  console.log(JSON.stringify(lanes, null, 2));
} else if (lanes.length === 0) {
  console.log(`no session active in the last ${activeMinutes} min`);
} else {
  const k = (n) => (n === null ? '—' : `${Math.round(n / 1000)}k`);
  for (const l of lanes)
    console.log(
      `${l.name.padEnd(18)} ${String(l.model ?? '').padEnd(18)} ${k(l.context).padStart(6)}  idle ${String(l.idleMinutes).padStart(3)}m  ${l.verdict}`,
    );
}
