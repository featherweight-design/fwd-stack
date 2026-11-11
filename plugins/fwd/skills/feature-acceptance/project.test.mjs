// node --test project.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  acceptanceConfig,
  importFromProject,
  need,
  parseArgs,
  projectRoot,
  SetupError,
} from './project.mjs';

test('parseArgs: flags with values, bare flags and positionals', () => {
  assert.deepEqual(parseArgs(['inv.json', '--root', '/p', '--strict-hex']), {
    flags: { root: '/p', 'strict-hex': true },
    positional: ['inv.json'],
  });
});

test('projectRoot: --root wins, resolved against the working directory', () => {
  assert.equal(projectRoot({ root: 'app' }, '/work'), '/work/app');
});

test('acceptanceConfig: the block, or a SetupError naming the file', () => {
  const block = { baseUrl: 'https://s.example.com' };
  assert.deepEqual(
    acceptanceConfig('/p', () => ({ featureAcceptance: block, invalid: [] })),
    block,
  );
  assert.throws(
    () => acceptanceConfig('/p', () => ({ invalid: [] })),
    (e) =>
      e instanceof SetupError &&
      /\/p\/\.claude\/fwd\.json has no "featureAcceptance"/.test(e.message),
  );
  assert.throws(
    () => acceptanceConfig('/p', () => ({ invalid: ['/p/.claude/fwd.json'] })),
    /not a JSON object/,
  );
});

test('need: a dotted field, or a SetupError naming it; empty strings and lists are missing', () => {
  assert.deepEqual(need({ tokens: { read: ['a'] } }, 'tokens.read', 'x'), [
    'a',
  ]);
  for (const block of [
    {},
    { tokens: {} },
    { tokens: { read: [] } },
    { tokens: { read: '' } },
  ])
    assert.throws(
      () => need(block, 'tokens.read', 'the globs'),
      /featureAcceptance\.tokens\.read is not set: the globs/,
    );
});

test('importFromProject: a package the project lacks is a SetupError saying why', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fwd-project-'));
  writeFileSync(path.join(root, 'package.json'), '{}');
  await assert.rejects(
    importFromProject(
      root,
      ['playwright', '@playwright/test'],
      'the sheet drives a browser',
    ),
    (e) =>
      e instanceof SetupError &&
      /playwright or @playwright\/test is not installed/.test(e.message),
  );
});
