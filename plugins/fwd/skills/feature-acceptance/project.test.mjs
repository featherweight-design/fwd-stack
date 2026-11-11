// node --test project.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  acceptanceConfig,
  importFromProject,
  need,
  parseArgs,
  projectRoot,
  readInventory,
  SetupError,
} from './project.mjs';

test('parseArgs: valued flags, switches and positionals', () => {
  assert.deepEqual(
    parseArgs(['inv.json', '--root', '/p', '--strict-hex'], {
      valued: ['root'],
      switches: ['strict-hex'],
    }),
    { flags: { root: '/p', 'strict-hex': true }, positional: ['inv.json'] },
  );
});

test('parseArgs: an unknown flag, or a valued flag with no value, is a SetupError', () => {
  const opts = { valued: ['root'], switches: ['strict-hex'] };
  assert.throws(
    () => parseArgs(['--strict-hx'], opts),
    /unknown flag --strict-hx/,
  );
  assert.throws(() => parseArgs(['--root'], opts), /--root takes a value/);
  assert.throws(
    () => parseArgs(['--root', '--strict-hex'], opts),
    (e) => e instanceof SetupError,
  );
});

test('readInventory: a missing or malformed file is a SetupError', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fwd-inv-'));
  writeFileSync(path.join(dir, 'bad.json'), '{ nope');
  writeFileSync(path.join(dir, 'ok.json'), '{"feature":"x"}');
  assert.deepEqual(await readInventory(path.join(dir, 'ok.json')), {
    feature: 'x',
  });
  await assert.rejects(
    readInventory(path.join(dir, 'bad.json')),
    /is not JSON/,
  );
  await assert.rejects(
    readInventory(path.join(dir, 'gone.json')),
    /cannot read/,
  );
  await assert.rejects(readInventory(undefined), /pass the inventory/);
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

test('importFromProject: packageDir may list several folders, searched in order, then the root', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fwd-pkgdir-'));
  writeFileSync(path.join(root, 'package.json'), '{}');
  // A stand-in package installed in the second app only.
  const pkg = path.join(root, 'apps', 'web', 'node_modules', 'fake-ts');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(path.join(root, 'apps', 'web', 'package.json'), '{}');
  writeFileSync(
    path.join(pkg, 'package.json'),
    '{"name":"fake-ts","main":"index.js"}',
  );
  writeFileSync(
    path.join(pkg, 'index.js'),
    'module.exports = { found: "web" };',
  );
  const mod = await importFromProject(root, ['fake-ts'], 'why', [
    'apps/e2e',
    'apps/web',
  ]);
  assert.equal(mod.found, 'web');
  await assert.rejects(
    importFromProject(root, ['fake-ts'], 'why', 'apps/e2e'),
    /is not installed in .*apps\/e2e or /,
  );
  await assert.rejects(
    importFromProject(root, ['fake-ts'], 'why', ['']),
    /a list of folders/,
  );
});
