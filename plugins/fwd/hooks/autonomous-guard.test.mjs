// node --test autonomous-guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const guard = fileURLToPath(new URL('./autonomous-guard.mjs', import.meta.url));
const env = () => ({
  ...process.env,
  CLAUDE_SESSION_ID: '',
  CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'guard-')),
});
const cli = (e, ...args) =>
  spawnSync('node', [guard, ...args], { env: e, encoding: 'utf8' });
const stop = (e, payload) =>
  execFileSync('node', [guard], {
    env: e,
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });

test('flags take a value with a space or an equals sign', () => {
  const e = env();
  assert.equal(
    cli(e, 'arm', 'do', 'it', '--minutes', '5', '--session', 's1').status,
    0,
  );
  const state = JSON.parse(cli(e, 'status', '--session=s1').stdout);
  assert.equal(state.reason, 'do it');
  assert.equal(state.max, 40);
  assert.ok(state.expiresAt - Date.now() <= 5 * 60_000);
});

test('a value that is not a positive number refuses to arm', () => {
  const e = env();
  const r = cli(e, 'arm', 'x', '--minutes=3h', '--session=s2');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /positive number/);
  assert.equal(
    JSON.parse(cli(e, 'status', '--session=s2').stdout).armed,
    false,
  );
});

test('an armed run keeps blocking across continuations until its cap', () => {
  const e = env();
  cli(e, 'arm', 'run', '--max=2', '--session=s3');
  const first = JSON.parse(
    stop(e, { session_id: 's3', stop_hook_active: false }),
  );
  const second = JSON.parse(
    stop(e, { session_id: 's3', stop_hook_active: true }),
  );
  assert.equal(first.decision, 'block');
  assert.equal(second.decision, 'block');
  const third = JSON.parse(
    stop(e, { session_id: 's3', stop_hook_active: true }),
  );
  assert.match(third.systemMessage, /continuation cap/);
});

test('an unarmed session is left alone', () => {
  assert.equal(stop(env(), { session_id: 'nobody' }), '');
});

test('a flag with no value refuses to arm', () => {
  for (const args of [
    ['--session=s3', '--max'],
    ['--max', '--session=s3'],
  ]) {
    const e = env();
    const r = cli(e, 'arm', 'x', ...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /needs a value/);
    assert.equal(
      JSON.parse(cli(e, 'status', '--session=s3').stdout).armed,
      false,
    );
  }
});

test('an explicit --session wins over CLAUDE_SESSION_ID', () => {
  const e = env();
  assert.equal(cli(e, 'arm', 'x', '--session=s5').status, 0);
  const withVar = { ...e, CLAUDE_SESSION_ID: 's4' };
  assert.equal(cli(withVar, 'disarm', '--session=s5').status, 0);
  assert.equal(
    JSON.parse(cli(e, 'status', '--session=s5').stdout).armed,
    false,
  );
});

test('a session waiting on a background command stops freely and spends nothing', () => {
  const e = env();
  cli(e, 'arm', 'run', '--max=2', '--session=s9');
  const transcript = join(mkdtempSync(join(tmpdir(), 'tx-')), 't.jsonl');
  writeFileSync(
    transcript,
    JSON.stringify({
      type: 'user',
      timestamp: new Date().toISOString(),
      message: {
        content: [
          {
            type: 'tool_result',
            content:
              'Command running in background with ID: b42. Output is being written to: /tmp/b42.output',
          },
        ],
      },
    }),
  );
  for (let i = 0; i < 5; i++)
    assert.equal(
      stop(e, { session_id: 's9', transcript_path: transcript }).trim(),
      '',
    );
  assert.equal(JSON.parse(cli(e, 'status', '--session=s9').stdout).count, 0);
  // Once the command reports back, the guard blocks again.
  writeFileSync(
    transcript,
    `${readFileSync(transcript, 'utf8')}\n${JSON.stringify({
      type: 'user',
      timestamp: new Date().toISOString(),
      message: {
        content:
          '<task-notification>\n<task-id>b42</task-id>\n<status>completed</status>\n</task-notification>',
      },
    })}`,
  );
  assert.equal(
    JSON.parse(stop(e, { session_id: 's9', transcript_path: transcript }))
      .decision,
    'block',
  );
});
