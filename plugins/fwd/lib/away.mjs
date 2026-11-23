#!/usr/bin/env node
// Whether the user is away: one window shared by every session, so lanes, the orchestrator and the
// session-budget hook agree without each remembering a flag. While it is open no lane stops for
// context, and rotation waits for the user's return. It closes on its own when it expires, or when
// the orchestrator clears it on the user's return.
//
//   node away.mjs set <hours>   open a window from now
//   node away.mjs clear         the user is back
//   node away.mjs status        print the window, or "present"
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { isMain } from './is-main.mjs';
import { pluginDataDir, pluginDataDirs } from './plugin-data.mjs';

const file = (env) => join(pluginDataDir(env), 'away.json');

// One window file read: `away` (with its end), `present` (no file, or expired) or `unknown` (a
// file is there but cannot be read or parsed: a torn write, a hand edit, a permissions fault).
function readWindow(path, now) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    return { state: e?.code === 'ENOENT' ? 'present' : 'unknown', until: null };
  }
  try {
    const { until } = JSON.parse(raw);
    if (typeof until !== 'number' || !Number.isFinite(until))
      return { state: 'unknown', until: null };
    return until > now
      ? { state: 'away', until }
      : { state: 'present', until: null };
  } catch {
    return { state: 'unknown', until: null };
  }
}

// The end of the window, or null: no window, an expired one and an unreadable one all read as
// present. The safe direction for rotation and stopping for context: a damaged file never strands
// a lane.
export function awayUntil(env = process.env, now = Date.now()) {
  return readWindow(file(env), now).until;
}

// The window for a rule that may only ever ADD a refusal, read once: `{ state, until }`. The
// opposite safe direction from awayUntil: a damaged file must not silently re-enable what an open
// window forbids, so such a caller treats `unknown` like `away` (and never uses it to relax
// anything). Every folder the writer or the kit could have used is read, because `away.mjs set`
// run from Bash and a hook can resolve different ones (see plugin-data.mjs): any open window
// wins, then any unreadable file, and the user is present only when all are clean and closed.
export function awayWindow(env = process.env, now = Date.now()) {
  const window = { state: 'present', until: null };
  for (const dir of pluginDataDirs(env)) {
    const w = readWindow(join(dir, 'away.json'), now);
    if (w.state === 'away') {
      window.state = 'away';
      window.until = Math.max(window.until ?? 0, w.until);
    } else if (w.state === 'unknown' && window.state !== 'away')
      window.state = 'unknown';
  }
  return window;
}

export const awayState = (env, now) => awayWindow(env, now).state;

export function setAway(hours, env = process.env, now = Date.now()) {
  if (!(hours > 0)) throw new Error('hours must be a positive number');
  mkdirSync(pluginDataDir(env), { recursive: true });
  const until = now + hours * 3_600_000;
  // Written aside and renamed into place: a hook reading mid-write sees the old window or the new
  // one, never a truncated file that would read as present.
  const tmp = `${file(env)}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ until }));
  renameSync(tmp, file(env));
  return until;
}

export function clearAway(env = process.env) {
  rmSync(file(env), { force: true });
}

if (isMain(import.meta.url)) {
  const [command, hours] = process.argv.slice(2);
  if (command === 'set') {
    const until = setAway(Number(hours));
    console.log(`away until ${new Date(until).toISOString()}`);
  } else if (command === 'clear') {
    clearAway();
    console.log('present');
  } else if (command === 'status') {
    const until = awayUntil();
    console.log(
      until ? `away until ${new Date(until).toISOString()}` : 'present',
    );
  } else {
    console.error('usage: away.mjs set <hours> | clear | status');
    process.exit(1);
  }
}
