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
import { pluginDataDir } from './plugin-data.mjs';

const file = (env) => join(pluginDataDir(env), 'away.json');

export function awayUntil(env = process.env, now = Date.now()) {
  try {
    const { until } = JSON.parse(readFileSync(file(env), 'utf8'));
    return typeof until === 'number' && until > now ? until : null;
  } catch {
    return null; // no window, or an unreadable one: treat the user as present
  }
}

// Three readings, for a rule that may only ever ADD a refusal while the user is away. `away`: an
// open window. `present`: no file, or a window that has expired. `unknown`: a file is there but
// cannot be read or parsed (a torn write, a hand edit, a permissions fault). A caller that adds
// refusals treats `unknown` like `away`: a damaged file must not silently re-enable what an open
// window forbids. A caller must never use `unknown` to relax anything.
export function awayState(env = process.env, now = Date.now()) {
  let raw;
  try {
    raw = readFileSync(file(env), 'utf8');
  } catch (e) {
    return e?.code === 'ENOENT' ? 'present' : 'unknown';
  }
  try {
    const { until } = JSON.parse(raw);
    if (typeof until !== 'number' || !Number.isFinite(until)) return 'unknown';
    return until > now ? 'away' : 'present';
  } catch {
    return 'unknown';
  }
}

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
