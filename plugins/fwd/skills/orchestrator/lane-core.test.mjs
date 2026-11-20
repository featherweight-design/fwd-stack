// node --test lane-core.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  laneName,
  projectDirName,
  sessionSummary,
  verdict,
} from './lane-core.mjs';

const turn = (usage, extra = {}) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-10-27T20:00:00Z',
    message: { model: 'claude-opus-5-5', usage },
    ...extra,
  });

test("a project folder name matches Claude Code's", () => {
  assert.equal(
    projectDirName('/Users/u/Projects/the-app'),
    '-Users-u-Projects-the-app',
  );
  assert.equal(projectDirName('/a/b.c d'), '-a-b-c-d');
});

test("a session's context is its last turn's input, cache reads and cache writes", () => {
  const jsonl = [
    '{"partial',
    JSON.stringify({ type: 'agent-name', agentName: 'lane-7' }),
    turn({
      input_tokens: 5,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 10,
    }),
    turn({
      input_tokens: 2,
      cache_read_input_tokens: 401303,
      cache_creation_input_tokens: 1016,
    }),
  ].join('\n');
  assert.deepEqual(sessionSummary(jsonl), {
    name: 'lane-7',
    agentName: 'lane-7',
    title: null,
    model: 'claude-opus-5-5',
    context: 402321,
    at: '2026-10-27T20:00:00Z',
  });
});

test("a subagent's turns in the same transcript do not count", () => {
  const jsonl = [
    turn({ input_tokens: 0, cache_read_input_tokens: 50_000 }),
    turn(
      { input_tokens: 0, cache_read_input_tokens: 900_000 },
      { isSidechain: true },
    ),
  ].join('\n');
  assert.equal(sessionSummary(jsonl).context, 50_000);
});

test('size alone never rotates a lane; past the compact window says compaction is due', () => {
  assert.equal(verdict(299_999), 'ok');
  assert.match(verdict(300_000), /compact window.*autoCompactWindow/);
  assert.doesNotMatch(verdict(900_000), /rotate/);
  assert.equal(verdict(399_999, { compactWindow: 400_000 }), 'ok');
  assert.equal(verdict(null), 'no turns yet');
});

test('an opt-in rotateAt rotates while present; while away it never stops a lane', () => {
  assert.match(
    verdict(200_000, { rotateAt: 150_000 }),
    /rotate at its next PR/,
  );
  assert.equal(verdict(149_999, { rotateAt: 150_000 }), 'ok');
  const away = verdict(900_000, { rotateAt: 150_000, away: true });
  assert.match(away, /keep working.*rotate on return/);
  assert.doesNotMatch(away, /stop/);
});

test('a relative or trailing-slash project path names the same transcript folder', () => {
  assert.equal(projectDirName('.'), projectDirName(process.cwd()));
  assert.equal(projectDirName('/a/b/'), projectDirName('/a/b'));
});

test('a session renamed twice shows its latest title, and an agent name wins', () => {
  const t = (customTitle) =>
    JSON.stringify({ type: 'custom-title', customTitle });
  assert.equal(sessionSummary([t('old'), t('new')].join('\n')).name, 'new');
  const agent = JSON.stringify({ type: 'agent-name', agentName: 'lane-a' });
  assert.equal(sessionSummary([agent, t('new')].join('\n')).name, 'lane-a');
});

test('an agent name from the head wins over a title in the tail', () => {
  const head = sessionSummary(
    JSON.stringify({ type: 'agent-name', agentName: 'lane-a' }),
  );
  const tail = sessionSummary(
    JSON.stringify({ type: 'custom-title', customTitle: 'later title' }),
  );
  assert.equal(laneName(tail, head), 'lane-a');
  assert.equal(laneName(tail, {}), 'later title');
  // A title only in the head may be superseded by a rename between the windows: not used.
  const oldTitle = sessionSummary(
    JSON.stringify({ type: 'custom-title', customTitle: 'old title' }),
  );
  assert.equal(laneName(sessionSummary(''), oldTitle), null);
  assert.equal(laneName(sessionSummary(''), {}), null);
});
