// node --test pre-compact.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { KEEP, guardState, instructions } from './pre-compact.mjs';

const SCRIPT = fileURLToPath(new URL('./pre-compact.mjs', import.meta.url));

test('the instructions name everything a lane needs after compaction', () => {
  const text = instructions({ now: 0 });
  for (const k of KEEP) assert.ok(text.includes(k));
  for (const word of [
    /role/,
    /orchestrator/,
    /STANDING RULES/,
    /open PR/,
    /watcher/,
    /away window/,
    /handoff file/,
    /exact next step/,
  ])
    assert.match(text, word);
  assert.ok(text.length < 10_000, 'under the harness cap');
});

test('facts: away, guard and pending watchers are carried; their absence is said', () => {
  const present = instructions({ now: 0 });
  assert.match(present, /away window is closed/);
  assert.match(present, /guard is not armed/);
  assert.match(present, /No background command found/);
  const away = instructions({
    now: 0,
    away: Date.UTC(2030, 0, 1),
    guard: {
      armed: true,
      reason: 'finish\n\n  the epic',
      count: 3,
      max: 200,
      expiresAt: Date.UTC(2030, 0, 1),
    },
    tasks: ['b1x', 'b2y'],
  });
  assert.match(away, /AWAY until 2030-01-01T00:00:00.000Z.*never stop/);
  assert.match(away, /ARMED until 2030.*3\/200.*"finish the epic"/);
  assert.match(away, /b1x, b2y/);
});

test('guardState reads only a live armed sentinel for this session', () => {
  const config = mkdtempSync(join(tmpdir(), 'precompact-'));
  const env = { CLAUDE_CONFIG_DIR: config };
  mkdirSync(join(config, 'autonomous'));
  writeFileSync(
    join(config, 'autonomous', 's1.json'),
    JSON.stringify({
      armed: true,
      reason: 'r',
      count: 0,
      max: 5,
      expiresAt: 10,
    }),
  );
  writeFileSync(join(config, 'autonomous', 's2.json'), '{"armed":false}');
  writeFileSync(
    join(config, 'autonomous', 's3.json'),
    JSON.stringify({
      armed: true,
      reason: 'r',
      count: 5,
      max: 5,
      expiresAt: 10,
    }),
  );
  assert.equal(guardState('s1', env, undefined, 5).reason, 'r');
  assert.equal(guardState('s1', env, undefined, 10), null, 'expired');
  assert.equal(guardState('s3', env, undefined, 5), null, 'cap spent');
  assert.equal(guardState('s2', env), null);
  assert.equal(guardState('nope', env), null);
  assert.equal(guardState(undefined, env), null);
});

test('as a hook it prints instructions and exits 0, even on a bad payload', () => {
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'precompact-')),
    CLAUDE_PLUGIN_DATA: mkdtempSync(join(tmpdir(), 'precompact-')),
  };
  const dir = mkdtempSync(join(tmpdir(), 'precompact-'));
  const transcript = join(dir, 't.jsonl');
  writeFileSync(
    transcript,
    JSON.stringify({
      type: 'user',
      timestamp: new Date().toISOString(),
      message: {
        content: [
          {
            type: 'tool_result',
            content: 'Command running in background with ID: bwatch1',
          },
        ],
      },
    }) + '\n',
  );
  const ok = spawnSync(process.execPath, [SCRIPT], {
    env,
    input: JSON.stringify({
      hook_event_name: 'PreCompact',
      trigger: 'auto',
      custom_instructions: null,
      session_id: 's',
      transcript_path: transcript,
    }),
    encoding: 'utf8',
  });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /Compaction instructions/);
  assert.match(ok.stdout, /bwatch1/);
  const bad = spawnSync(process.execPath, [SCRIPT], {
    env,
    input: 'not json',
    encoding: 'utf8',
  });
  assert.equal(bad.status, 0);
  assert.match(bad.stdout, /Compaction instructions/);
});
