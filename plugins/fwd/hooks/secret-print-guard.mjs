#!/usr/bin/env node
// PreToolUse guard for Bash: denies commands that would print a secret into the transcript, such
// as an environment dump, reading a .env file, or listing process command lines. The rule itself,
// and what it does and does not catch, is in secret-guard.mjs.
import { readFileSync } from 'node:fs';

import { secretDecision } from './secret-guard.mjs';

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
  reason = secretDecision(input.tool_input?.command);
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
