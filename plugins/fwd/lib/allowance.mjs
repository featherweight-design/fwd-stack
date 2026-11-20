// One-shot allowances for commands local-test-guard would deny (a single approved build or test
// run). Only the user can arm one: they type `! node .../hooks/allow-once.mjs "<command>"
// --session=<id>` in their own prompt, and `!` commands never pass through PreToolUse hooks. The
// guards in this kit deny every agent attempt to run that script or touch the folder it writes to.
//
// A record is one JSON file in `<plugin data>/allow-once/`. It names the exact normalized
// command, the session that may use it, and an expiry. Matching is exact: no prefix, substring or
// compound matching, so `pnpm build && rm -rf x` never rides on an allowance for `pnpm build`.
// Using a record deletes it first (rename, then unlink), so two calls cannot both use it.
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

import { pluginDataDir } from './plugin-data.mjs';

export const MAX_MINUTES = 15;

// Both spellings of the data folder: the one Claude Code exports to hooks, and the one derived
// from its documented name, which is what a command run from the user's shell sees.
const dataDirs = (env = process.env, home = homedir()) => [
  ...new Set([
    pluginDataDir(env, home),
    pluginDataDir({ ...env, CLAUDE_PLUGIN_DATA: '' }, home),
  ]),
];

export const allowanceDir = (env = process.env, home = homedir()) =>
  join(pluginDataDir(env, home), 'allow-once');

// Whitespace-only normalization. Newlines are never folded (they separate commands), and a
// command with quotes or backslashes keeps its inner spacing, which is part of an argument.
export function normalize(command) {
  if (typeof command !== 'string') return null;
  const t = command.trim();
  if (!t || /[\n\r\0]/.test(t)) return null;
  return /['"\\]/.test(t) ? t : t.replace(/[ \t]+/g, ' ');
}

export function arm(
  { command, session, minutes = MAX_MINUTES },
  env = process.env,
  now = Date.now(),
) {
  const cmd = normalize(command);
  if (!cmd) throw new Error('give one command on a single line');
  if (!session || !/^[\w.-]+$/.test(session))
    throw new Error('--session <session id> is required');
  const mins = Math.min(Number(minutes) || MAX_MINUTES, MAX_MINUTES);
  const dir = allowanceDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const record = {
    command: cmd,
    session,
    created: now,
    expires: now + mins * 60_000,
    used: false,
  };
  // Written whole under a name consume() ignores, then renamed into place, so a reader never
  // sees a partial record.
  const id = randomBytes(8).toString('hex');
  writeFileSync(join(dir, `${id}.tmp`), JSON.stringify(record), {
    mode: 0o600,
  });
  renameSync(join(dir, `${id}.tmp`), join(dir, `${id}.json`));
  return record;
}

// Consumes and returns the record that allows `command` in `session`, or null. Expired and
// unreadable records are deleted as they are read.
export function consume(command, session, env = process.env, now = Date.now()) {
  const cmd = normalize(command);
  if (!cmd || !session) return null;
  const dir = allowanceDir(env);
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    const file = join(dir, name);
    if (!name.endsWith('.json')) continue;
    let rec;
    try {
      rec = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      rmSync(file, { force: true });
      continue;
    }
    if (!(rec?.expires > now) || rec.used !== false) {
      rmSync(file, { force: true });
      continue;
    }
    if (rec.session !== session || rec.command !== cmd) continue;
    // rename is atomic: of two callers racing for one record, one gets ENOENT.
    const claimed = `${file}.claim-${process.pid}-${randomBytes(4).toString('hex')}`;
    try {
      renameSync(file, claimed);
    } catch {
      continue;
    }
    rmSync(claimed, { force: true });
    return rec;
  }
  return null;
}

const TAMPER =
  /allow[-_ ]?once|CLAUDE_PLUGIN_DATA|fwd-fwd-stack|plugins\/data/i;

// The reason a Bash command may not be run by an agent, or null: it names the arming script or
// the folder the records live in. Text-based, so it catches names, paths and env references but
// not a path assembled at run time; the write guard and the folder's 0700 mode back it up.
export function bashTamperReason(command, env = process.env) {
  if (typeof command !== 'string') return null;
  const dirs = dataDirs(env).map((d) => d.replace(/\\/g, '/'));
  const text = command.replace(/\\/g, '/');
  // Quotes inside a word (`allow-"once`) vanish when the shell runs it, so test both forms.
  const bare = text.replace(/['"]/g, '');
  if (
    [text, bare].some((t) => TAMPER.test(t) || dirs.some((d) => t.includes(d)))
  )
    return 'allow-once is armed by the user only; an agent may not run it or touch its records.';
  return null;
}

// Resolve symlinks through the deepest existing ancestor, so a link into the folder is seen.
const realish = (p) => {
  let cur = p;
  const rest = [];
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest.reverse());
    } catch {
      const up = dirname(cur);
      if (up === cur) return p;
      rest.push(cur.slice(up.length + 1));
      cur = up;
    }
  }
};

// The reason a file write is refused, or null: its path is inside (or names) the allowance folder.
export function writeTamperReason(input, env = process.env, home = homedir()) {
  const ti = input?.tool_input ?? {};
  const raw = ti.file_path ?? ti.notebook_path ?? ti.path;
  if (typeof raw !== 'string' || !raw) return null;
  const abs = isAbsolute(raw) ? raw : resolve(input?.cwd ?? process.cwd(), raw);
  const targets = [abs, realish(abs)];
  const dirs = dataDirs(env, home).flatMap((d) => [d, realish(d)]);
  const inside = targets.some(
    (t) =>
      /[\\/]allow-once([\\/]|$)/.test(t) ||
      dirs.some((d) => t === d || t.startsWith(d + sep)),
  );
  return inside
    ? 'allow-once records are written by the user only; an agent may not write to them.'
    : null;
}
