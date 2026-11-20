#!/usr/bin/env node
// Arms a one-shot allowance for a command local-test-guard denies. The USER runs this from their
// own prompt with `!`, which skips PreToolUse hooks; every guard denies an agent running it.
//
//   ! node ~/.claude/fwd/hooks/allow-once.mjs "pnpm build" --session=<session id>
//
// The session id is the lane's `$CLAUDE_SESSION_ID`; the lane prints it when it asks. The command
// must match exactly (whitespace aside), is good for one use and expires in 15 minutes.
import { MAX_MINUTES, arm } from '../lib/allowance.mjs';
import { isMain } from '../lib/is-main.mjs';

if (isMain(import.meta.url)) {
  const words = [];
  const flags = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const m = /^--(session|minutes)(?:=(.*))?$/.exec(argv[i]);
    if (!m) words.push(argv[i]);
    else {
      const value = m[2] ?? argv[++i];
      if (value === undefined || value.startsWith('--')) {
        console.error(`allow-once: --${m[1]} needs a value`);
        process.exit(2);
      }
      flags[m[1]] = value;
    }
  }
  try {
    if (words.length !== 1)
      throw new Error('pass the command as ONE quoted argument');
    const rec = arm({ command: words[0], ...flags });
    console.log(
      `allowed once: ${rec.command}\n  session ${rec.session}, expires ${new Date(rec.expires).toISOString()} (max ${MAX_MINUTES} min)`,
    );
  } catch (e) {
    console.error(`allow-once: ${e.message}`);
    process.exit(2);
  }
}
