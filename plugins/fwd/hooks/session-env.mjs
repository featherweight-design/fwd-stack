#!/usr/bin/env node
// Put the session id where a lane's Bash calls can read it.
//
// Claude Code does not set CLAUDE_SESSION_ID in the environment of a Bash call, yet the lane skill
// tells a lane to `echo $CLAUDE_SESSION_ID` (for allow-once.mjs) and autonomous-guard.mjs arm falls
// back to it. SessionStart hooks receive the id as `session_id` on stdin and a CLAUDE_ENV_FILE
// path: lines appended to that file are sourced before each later Bash call.
//
// So this appends `export CLAUDE_SESSION_ID=<id>` there, only when the id matches [A-Za-z0-9-]+
// (it is written into a file that is sourced as shell). It prints nothing and always exits 0: a
// hook that cannot write the variable must never break session start.
import { appendFileSync, readFileSync } from 'node:fs';

import { isMain } from '../lib/is-main.mjs';

const SAFE_ID = /^[A-Za-z0-9-]{1,128}$/;

// The id from the hook's stdin JSON, or null when absent or not safe to write.
export function sessionId(raw) {
  try {
    const id = JSON.parse(raw)?.session_id;
    return typeof id === 'string' && SAFE_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

// Append the export line; true when written. Never throws.
export function writeEnv(raw, envFile) {
  try {
    const id = sessionId(raw);
    if (id === null || typeof envFile !== 'string' || envFile === '')
      return false;
    // A leading newline keeps the line apart from an earlier hook's line that lacks a final one.
    appendFileSync(envFile, `\nexport CLAUDE_SESSION_ID=${id}\n`);
    return true;
  } catch {
    return false;
  }
}

if (isMain(import.meta.url)) {
  let raw = '';
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    // No stdin: nothing to write.
  }
  writeEnv(raw, process.env.CLAUDE_ENV_FILE);
  process.exit(0);
}
