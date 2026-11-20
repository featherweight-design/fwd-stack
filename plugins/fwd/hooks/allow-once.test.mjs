// node --test allow-once.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  allowanceDir,
  arm,
  bashTamperReason,
  consume,
  normalize,
  writeTamperReason,
} from '../lib/allowance.mjs';

const here = (f) => fileURLToPath(new URL(f, import.meta.url));
const guard = here('./local-test-guard.mjs');
const writeGuard = here('./allow-once-write-guard.mjs');
const cli = here('./allow-once.mjs');

const sandbox = () => {
  const dir = mkdtempSync(join(tmpdir(), 'allow-once-'));
  return { ...process.env, CLAUDE_PLUGIN_DATA: dir };
};
const runGuard = (env, command, session = 'lane-a') => {
  const out = execFileSync('node', [guard], {
    env,
    encoding: 'utf8',
    input: JSON.stringify({
      tool_name: 'Bash',
      session_id: session,
      tool_input: { command },
    }),
  });
  return out ? JSON.parse(out).hookSpecificOutput : null;
};
const armCli = (env, ...args) =>
  spawnSync('node', [cli, ...args], { env, encoding: 'utf8' });

test('arm, then match once, then consumed', () => {
  const env = sandbox();
  assert.equal(armCli(env, 'pnpm build', '--session=lane-a').status, 0);
  const first = runGuard(env, 'pnpm   build');
  assert.equal(first.permissionDecision, 'allow');
  assert.match(first.permissionDecisionReason, /allowance used/);
  assert.equal(runGuard(env, 'pnpm build').permissionDecision, 'deny');
  assert.deepEqual(readdirSync(allowanceDir(env)), []);
});

test('the deny message tells a lane how to ask', () => {
  const out = runGuard(sandbox(), 'pnpm build');
  assert.match(out.permissionDecisionReason, /allow-once\.mjs/);
  assert.match(out.permissionDecisionReason, /--session=/);
});

test('an expired allowance does not match and is cleaned on read', () => {
  const env = sandbox();
  arm({ command: 'pnpm build', session: 's' }, env, Date.now() - 16 * 60_000);
  assert.equal(consume('pnpm build', 's', env), null);
  assert.deepEqual(readdirSync(allowanceDir(env)), []);
});

test('the lifetime is capped at 15 minutes', () => {
  const rec = arm(
    { command: 'pnpm build', session: 's', minutes: 999 },
    sandbox(),
    0,
  );
  assert.equal(rec.expires, 15 * 60_000);
});

test('another session cannot use it, and it survives for its own', () => {
  const env = sandbox();
  armCli(env, 'pnpm build', '--session=lane-a');
  assert.equal(
    runGuard(env, 'pnpm build', 'lane-b').permissionDecision,
    'deny',
  );
  assert.equal(
    runGuard(env, 'pnpm build', undefined).permissionDecision,
    'deny',
  );
  assert.equal(
    runGuard(env, 'pnpm build', 'lane-a').permissionDecision,
    'allow',
  );
});

test('another command does not match: no prefix, substring or compound', () => {
  const env = sandbox();
  armCli(env, 'pnpm build', '--session=lane-a');
  for (const c of [
    'pnpm build --filter web',
    'pnpm test',
    'pnpm build && rm -rf x',
    'pnpm build; rm -rf x',
    'pnpm build | tee out',
    'pnpm build\nrm -rf x',
    'pnpm build $(rm -rf x)',
    'echo hi && pnpm build',
  ])
    assert.equal(runGuard(env, c).permissionDecision, 'deny', c);
  // still unused
  assert.equal(runGuard(env, 'pnpm build').permissionDecision, 'allow');
});

test('an allowance for a compound command matches only that exact text', () => {
  const env = sandbox();
  armCli(env, 'pnpm build && pnpm test', '--session=lane-a');
  assert.equal(runGuard(env, 'pnpm build').permissionDecision, 'deny');
  assert.equal(
    runGuard(env, 'pnpm build && pnpm test').permissionDecision,
    'allow',
  );
});

test('quoted arguments keep their inner spacing', () => {
  assert.equal(normalize('  pnpm   build  '), 'pnpm build');
  assert.equal(normalize('echo "a  b"'), 'echo "a  b"');
  assert.equal(normalize('a\nb'), null);
});

test('only one of two racing consumers gets the allowance', () => {
  const env = sandbox();
  arm({ command: 'pnpm build', session: 's' }, env);
  const got = [
    consume('pnpm build', 's', env),
    consume('pnpm build', 's', env),
  ];
  assert.equal(got.filter(Boolean).length, 1);
});

test('arming needs a session and one command', () => {
  const env = sandbox();
  assert.equal(armCli(env, 'pnpm build').status, 2);
  assert.equal(armCli(env, '--session=x').status, 2);
  assert.equal(armCli(env, 'a', 'b', '--session=x').status, 2);
  assert.equal(existsSync(allowanceDir(env)), false);
});

test('an agent cannot run the script or name the records folder', () => {
  const env = sandbox();
  const dir = allowanceDir(env);
  for (const c of [
    'node ~/.claude/fwd/hooks/allow-once.mjs "pnpm build" --session=x',
    'node hooks/allow_once.mjs',
    'node "plugins/fwd/hooks/allow-"once.mjs x',
    `cp x.json ${dir}/a.json`,
    `echo '{}' | tee ${dir}/a.json`,
    `node -e "require('fs').writeFileSync('${dir}/a.json','{}')"`,
    'cat > "$CLAUDE_PLUGIN_DATA/allow-once/a.json"',
    'ls ~/.claude/plugins/data/fwd-fwd-stack',
    'ln -s ~/.claude/plugins/data x',
  ])
    assert.equal(runGuard(env, c).permissionDecision, 'deny', c);
  assert.equal(bashTamperReason('pnpm typecheck'), null);
});

test('the write guard denies Write, Edit and NotebookEdit into the folder', () => {
  const env = sandbox();
  const dir = allowanceDir(env);
  const run = (tool_name, tool_input, cwd) => {
    const out = execFileSync('node', [writeGuard], {
      env,
      encoding: 'utf8',
      input: JSON.stringify({ tool_name, tool_input, cwd }),
    });
    return out ? JSON.parse(out).hookSpecificOutput.permissionDecision : null;
  };
  assert.equal(run('Write', { file_path: `${dir}/a.json` }), 'deny');
  assert.equal(
    run('Edit', { file_path: join(dir, 'x', '..', 'a.json') }),
    'deny',
  );
  assert.equal(run('MultiEdit', { file_path: 'a.json' }, dir), 'deny');
  assert.equal(
    run('NotebookEdit', { notebook_path: `${dir}/n.ipynb` }),
    'deny',
  );
  assert.equal(run('Write', { file_path: '/tmp/allow-once/a.json' }), 'deny');
  assert.equal(run('Write', { file_path: '/tmp/notes.txt' }), null);
  assert.equal(writeTamperReason({ tool_input: {} }), null);
});

test('a symlink into the folder is seen by the write guard', () => {
  const env = sandbox();
  arm({ command: 'pnpm build', session: 's' }, env);
  const link = join(mkdtempSync(join(tmpdir(), 'link-')), 'l');
  execFileSync('ln', ['-s', allowanceDir(env), link]);
  assert.ok(
    writeTamperReason({ tool_input: { file_path: join(link, 'a.json') } }, env),
  );
  writeFileSync(join(allowanceDir(env), 'junk.json'), '{ nope');
  assert.equal(consume('pnpm build', 'other', env), null);
  assert.equal(existsSync(join(allowanceDir(env), 'junk.json')), false);
});
