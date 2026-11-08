// node --test gate-path.test.mjs
// Which gate the hook runs: the newest installed one through ~/.claude/fwd when that link really
// resolves into the fwd plugin cache, otherwise the one bundled with the session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compareVersions, resolveGate } from './gate-path.mjs';

const GATE = join('skills', 'pr-review', 'pr-gate.mjs');

// A scratch home with the given cached versions of the plugin, and ~/.claude/fwd linked to `link`.
function home({ versions = [], link } = {}) {
  const h = realpathSync(mkdtempSync(join(tmpdir(), 'gate-path-')));
  const cache = join(h, '.claude', 'plugins', 'cache', 'fwd-stack', 'fwd');
  mkdirSync(cache, { recursive: true });
  for (const v of versions) {
    mkdirSync(join(cache, v, 'skills', 'pr-review'), { recursive: true });
    writeFileSync(join(cache, v, GATE), '');
  }
  if (link) symlinkSync(link(h, cache), join(h, '.claude', 'fwd'));
  return { h, cache, at: (v) => join(cache, v, GATE) };
}

const outsideBundle = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'gate-bundle-')));
  mkdirSync(join(d, 'skills', 'pr-review'), { recursive: true });
  writeFileSync(join(d, GATE), '');
  return join(d, GATE);
};

test('runs the newest installed gate when ~/.claude/fwd links into the cache', () => {
  const { h, at } = home({
    versions: ['0.1.13', '0.1.16'],
    link: (_, c) => join(c, '0.1.16'),
  });
  assert.equal(resolveGate(at('0.1.13'), h, {}), at('0.1.16'));
});

test('falls back to the bundled gate when there is no link', () => {
  const { h, at } = home({ versions: ['0.1.13'] });
  assert.equal(resolveGate(at('0.1.13'), h), at('0.1.13'));
});

test('falls back to the bundled gate when the link points outside the plugin cache', () => {
  const elsewhere = outsideBundle();
  const { h, at } = home({
    versions: ['0.1.13'],
    link: () => join(elsewhere, '..', '..', '..'),
  });
  assert.equal(resolveGate(at('0.1.13'), h), at('0.1.13'));
});

test('falls back to the bundled gate when the link points at another plugin', () => {
  const { h, cache, at } = home({ versions: ['0.1.13'] });
  const other = join(cache, '..', '..', 'other', 'other', '1.0.0');
  mkdirSync(join(other, 'skills', 'pr-review'), { recursive: true });
  writeFileSync(join(other, GATE), '');
  symlinkSync(other, join(h, '.claude', 'fwd'));
  assert.equal(resolveGate(at('0.1.13'), h), at('0.1.13'));
});

test('never steps back to an older version than the bundled one', () => {
  const { h, at } = home({
    versions: ['0.1.15', '0.1.16'],
    link: (_, c) => join(c, '0.1.15'),
  });
  assert.equal(resolveGate(at('0.1.16'), h), at('0.1.16'));
});

test('a bundled gate outside the cache (a checkout) still defers to the newest install', () => {
  const bundled = outsideBundle();
  const { h, at } = home({
    versions: ['0.1.16'],
    link: (_, c) => join(c, '0.1.16'),
  });
  assert.equal(resolveGate(bundled, h), at('0.1.16'));
});

test('a link whose gate file is missing falls back to the bundled gate', () => {
  const { h, cache, at } = home({ versions: ['0.1.13'] });
  mkdirSync(join(cache, '0.1.16'));
  symlinkSync(join(cache, '0.1.16'), join(h, '.claude', 'fwd'));
  assert.equal(resolveGate(at('0.1.13'), h), at('0.1.13'));
});

test('a version that cannot be compared with the bundled one keeps the bundled gate', () => {
  const { h, at } = home({
    versions: ['0.1.16', '0.1.17-rc'],
    link: (_, c) => join(c, '0.1.17-rc'),
  });
  assert.equal(resolveGate(at('0.1.16'), h), at('0.1.16'));
});

test("another marketplace's fwd install is not trusted over the bundled one", () => {
  const { h, cache, at } = home({ versions: ['0.1.13'] });
  const other = join(cache, '..', '..', 'elsewhere', 'fwd', '9.9.9');
  mkdirSync(join(other, 'skills', 'pr-review'), { recursive: true });
  writeFileSync(join(other, GATE), '');
  symlinkSync(other, join(h, '.claude', 'fwd'));
  assert.equal(resolveGate(at('0.1.13'), h), at('0.1.13'));
});

test('compareVersions orders dotted numbers and refuses anything else', () => {
  assert.equal(compareVersions('0.1.9', '0.1.16'), -1);
  assert.equal(compareVersions('0.1.16', '0.1.16'), 0);
  assert.equal(compareVersions('0.2.0', '0.1.16'), 1);
  assert.equal(compareVersions('dev', '0.1.16'), null);
});

test('follows CLAUDE_CONFIG_DIR to the link, as hooks/fwd-link.mjs does', () => {
  const { h, at } = home({
    versions: ['0.1.13', '0.1.16'],
    link: (_, c) => join(c, '0.1.16'),
  });
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'gate-home-')));
  assert.equal(
    resolveGate(at('0.1.13'), elsewhere, {
      CLAUDE_CONFIG_DIR: join(h, '.claude'),
    }),
    at('0.1.16'),
  );
  assert.equal(
    resolveGate(at('0.1.13'), h, { CLAUDE_CONFIG_DIR: elsewhere }),
    at('0.1.13'),
    'no link in the configured folder: the bundled gate',
  );
});
