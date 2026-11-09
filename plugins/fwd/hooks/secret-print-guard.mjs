#!/usr/bin/env node
// PreToolUse guard for Bash: denies commands that would print a secret into the transcript, such
// as an environment dump, reading a .env file, or listing process command lines. The rule itself,
// and what it does and does not catch, is in secret-guard.mjs.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { isSecretEnvFile, secretDecision } from './secret-guard.mjs';

// Whether a folder a recursive search starts from holds a .env file within a few levels (a
// monorepo keeps them in apps/<name>/). Bounded so a huge tree cannot stall the call; when the
// bound is hit, or the path cannot be resolved, it answers null and the guard's own rule decides.
const SKIP = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  '.turbo',
]);
function hasEnvFile(cwd) {
  return (root) => {
    const home = homedir();
    let path = root
      .replace(/^~(?=\/|$)/, home)
      .replace(/\$\{?HOME\}?/g, home)
      .replace(/\$\{?PWD\}?/g, cwd);
    if (path.includes('$')) return null;
    if (path === '*' || path === '.*') path = '.';
    path = resolve(cwd, path);
    let budget = 4000;
    const walk = (dir, depth) => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return false;
      }
      for (const e of entries) {
        if (--budget < 0) throw new Error('budget');
        if (e.isFile() && isSecretEnvFile(e.name)) return true;
      }
      if (depth === 0) return false;
      for (const e of entries)
        if (
          e.isDirectory() &&
          !SKIP.has(e.name) &&
          walk(join(dir, e.name), depth - 1)
        )
          return true;
      return false;
    };
    try {
      if (!statSync(path).isDirectory()) return false;
      return walk(path, 3);
    } catch (err) {
      return err.message === 'budget' ? null : false;
    }
  };
}

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}
if (input.tool_name !== undefined && input.tool_name !== 'Bash')
  process.exit(0);

let reason = null;
try {
  reason = secretDecision(input.tool_input?.command, {
    hasEnvFile: hasEnvFile(String(input.cwd || process.cwd())),
  });
} catch {
  // A parser failure must never block work; this guard catches accidents, it is not a sandbox.
  process.exit(0);
}
if (reason)
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `secret-print-guard: ${reason} Command output is saved in the transcript, so a printed secret has leaked. Ask the user if you truly need this output.`,
      },
    }),
  );
