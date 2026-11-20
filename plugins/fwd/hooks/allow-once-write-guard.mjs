#!/usr/bin/env node
// PreToolUse guard for Write, Edit, MultiEdit and NotebookEdit: denies writes into the allow-once
// folder, so an agent cannot arm an allowance by writing the record itself.
import { readFileSync } from 'node:fs';

import { writeTamperReason } from '../lib/allowance.mjs';
import { isMain } from '../lib/is-main.mjs';

if (isMain(import.meta.url)) {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.exit(0);
  }
  const reason = writeTamperReason(input);
  if (reason)
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `allow-once-write-guard: ${reason}`,
        },
      }),
    );
}
