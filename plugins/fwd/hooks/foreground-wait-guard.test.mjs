// node --test foreground-wait-guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  foregroundWaitDecision,
  sleepSeconds,
} from './foreground-wait-guard.mjs';

// [command, pattern the reason must match]
const DENY = [
  // the polling loop that held a turn for ten minutes
  [
    'for i in $(seq 1 13); do gh pr checks 66 && break; sleep 45; done',
    /inside a loop/,
  ],
  // long sleeps
  ['sleep 30', /sleep 30/],
  ['sleep 45', /sleep 45/],
  ['sleep 600', /sleep 600/],
  ['sleep 1m', /sleep 1m/],
  ['sleep 0.5h', /sleep 0.5h/],
  ['sleep 20 15', /sleep 20 15/],
  ['sleep infinity', /sleep infinity/],
  ['sleep -- 60', /sleep -- 60/],
  ['/bin/sleep 60', /sleep 60/],
  ['echo waiting; sleep 120; gh pr checks 5', /sleep 120/],
  ['git push && sleep 60 && gh pr checks', /sleep 60/],
  // any sleep in a loop
  ['while true; do sleep 5; done', /inside a loop/],
  [
    'while :; do gh pr checks 5 | grep -q pending || break; sleep 10; done',
    /inside a loop/,
  ],
  ['until gh pr checks 5; do sleep 2; done', /inside a loop/],
  ['for i in 1 2 3; do echo $i; sleep 1; done', /inside a loop/],
  ['while sleep 5; do date; done', /inside a loop/],
  ['while true\ndo\n  sleep 5\ndone', /inside a loop/],
  ['if true; then while true; do sleep 1; done; fi', /inside a loop/],
  ['while true; do bash -c "sleep 1"; done', /inside a loop/],
  [
    'N=10; while [ $N -gt 0 ]; do N=$((N-1)); sleep "$DELAY"; done',
    /inside a loop/,
  ],
  // gh watchers
  ['gh pr checks 66 --watch', /--watch/],
  ['gh pr checks --watch --interval 30', /--watch/],
  ['gh pr checks 66 --watch=true', /--watch/],
  ['gh run watch 123', /gh run watch/],
  ['gh run watch', /gh run watch/],
  ['gh -R owner/repo run watch 123', /gh run watch/],
  ['gh run watch 123 --exit-status && echo ok', /gh run watch/],
  // follows and repeats
  ['tail -f server.log', /tail -f/],
  ['tail -F server.log', /tail -f/],
  ['tail -n 50 -f server.log', /tail -f/],
  ['tail -fn 100 server.log', /tail -f/],
  ['tail --follow=name server.log', /tail -f/],
  ['tail -f dev.log | grep --line-buffered ERROR', /tail -f/],
  ['watch gh pr checks 5', /`watch`/],
  ['watch -n 30 "gh pr checks 5"', /`watch`/],
  // wrappers and nesting
  ['timeout 600 gh run watch 123', /gh run watch/],
  [
    "timeout 600 bash -c 'until gh pr checks 5; do sleep 15; done'",
    /inside a loop/,
  ],
  ['nohup sleep 300', /sleep 300/],
  ["bash -c 'sleep 60'", /sleep 60/],
  ['sh -c "gh pr checks 5 --watch"', /--watch/],
  ['eval sleep 60', /sleep 60/],
  ['x=$(sleep 60; echo done)', /sleep 60/],
  ['(cd web && sleep 45)', /sleep 45/],
  ['bash <<EOF\nwhile true; do sleep 5; done\nEOF', /inside a loop/],
];

const ALLOW = [
  'sleep 5',
  'sleep 29',
  'sleep 0.5',
  'sleep 10s',
  'sleep 2 && gh pr checks 5',
  'sleep $DELAY',
  'sleep',
  'sleep --help',
  'gh pr checks 66',
  'gh pr view 66 --json state',
  'gh run view 123 --log-failed',
  'gh run list --limit 5',
  'tail -n 50 server.log',
  'tail -c 200 server.log',
  'echo "sleep 60"',
  "echo 'while true; do sleep 5; done'",
  'git commit -m "fix: sleep 60 in the poller"',
  'grep -rn "sleep 45" scripts',
  'grep -n watch README.md',
  'for f in *.ts; do echo $f; done',
  'while read -r line; do echo "$line"; done < list.txt',
  'for i in 1 2; do echo $i; done; sleep 5',
  'command -v watch',
  'which tail',
  'node --check plugins/fwd/hooks/foreground-wait-guard.mjs',
  'pnpm format:check && pnpm typecheck && pnpm lint',
  '',
];

test('denies a long foreground wait in any segment', () => {
  for (const [command, pattern] of DENY) {
    const reason = foregroundWaitDecision(command);
    assert.ok(reason, `expected a denial: ${JSON.stringify(command)}`);
    assert.match(reason, pattern, JSON.stringify(command));
    assert.match(reason, /run_in_background/);
  }
});

test('allows quick commands, short sleeps and text that only mentions a wait', () => {
  for (const command of ALLOW)
    assert.equal(
      foregroundWaitDecision(command),
      null,
      `expected allow: ${JSON.stringify(command)}`,
    );
});

test('a background call always passes', () => {
  for (const [command] of DENY)
    assert.equal(foregroundWaitDecision(command, true), null, command);
});

test('only a literal true means background', () => {
  assert.ok(foregroundWaitDecision('sleep 60', 'true'));
  assert.ok(foregroundWaitDecision('sleep 60', 1));
  assert.ok(foregroundWaitDecision('sleep 60', false));
});

test('a non-string command is allowed', () => {
  assert.equal(foregroundWaitDecision(undefined), null);
  assert.equal(foregroundWaitDecision(42), null);
});

test('sleepSeconds sums operands and reads suffixes', () => {
  assert.equal(sleepSeconds(['45']), 45);
  assert.equal(sleepSeconds(['1m', '30s']), 90);
  assert.equal(sleepSeconds(['.5']), 0.5);
  assert.equal(sleepSeconds(['2h']), 7200);
  assert.equal(sleepSeconds(['1d']), 86400);
  assert.equal(sleepSeconds(['inf']), Infinity);
  assert.equal(sleepSeconds(['$N']), null);
  assert.equal(sleepSeconds([]), null);
});

// The hook itself: stdin payload in, deny JSON (or nothing) out.
const hook = fileURLToPath(
  new URL('./foreground-wait-guard.mjs', import.meta.url),
);
const run = (payload) =>
  execFileSync('node', [hook], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
  });

test('the hook denies a foreground polling loop', () => {
  const out = JSON.parse(
    run({
      tool_name: 'Bash',
      tool_input: { command: 'while true; do sleep 45; done' },
    }),
  );
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(
    out.hookSpecificOutput.permissionDecisionReason,
    /^foreground-wait-guard: /,
  );
});

test('the hook stays silent on a background wait, a short command, another tool, or bad input', () => {
  assert.equal(
    run({
      tool_name: 'Bash',
      tool_input: {
        command: 'while true; do sleep 45; done',
        run_in_background: true,
      },
    }),
    '',
  );
  assert.equal(
    run({ tool_name: 'Bash', tool_input: { command: 'gh pr checks 5' } }),
    '',
  );
  assert.equal(
    run({ tool_name: 'Read', tool_input: { command: 'sleep 60' } }),
    '',
  );
  assert.equal(run({ tool_name: 'Bash', tool_input: {} }), '');
  assert.equal(run('{ not json'), '');
  assert.equal(run('null'), '');
});
