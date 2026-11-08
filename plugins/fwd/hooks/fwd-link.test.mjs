// node --test fwd-link.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';

import {
  cacheEntry,
  installedPath,
  paths,
  plan,
  relink,
  repoint,
} from './fwd-link.mjs';

// A config folder with fwd 0.1.1 and 0.1.2 cached, ~/.claude/fwd -> 0.1.1, and 0.1.2 installed.
function machine({
  installed = '0.1.2',
  linked = '0.1.1',
  mkt = 'fwd-stack',
} = {}) {
  const config = realpathSync(mkdtempSync(join(tmpdir(), 'fwd-link-')));
  const p = paths({ CLAUDE_CONFIG_DIR: config });
  for (const v of ['0.1.1', '0.1.2', '0.1.10', 'dev']) {
    mkdirSync(join(p.cache, mkt, 'fwd', v), { recursive: true });
  }
  const dir = (v) => join(p.cache, mkt, 'fwd', v);
  symlinkSync(dir(linked), p.link);
  const write = (v, scope = 'user') =>
    writeFileSync(
      p.installed,
      JSON.stringify({
        version: 2,
        plugins: { [`fwd@${mkt}`]: [{ scope, installPath: dir(v) }] },
      }),
    );
  write(installed);
  return { p, dir, write };
}

test('paths follow CLAUDE_CONFIG_DIR and CLAUDE_CODE_PLUGIN_CACHE_DIR', () => {
  assert.deepEqual(paths({ CLAUDE_CONFIG_DIR: '/c' }, '/h'), {
    link: '/c/fwd',
    cache: '/c/plugins/cache',
    installed: '/c/plugins/installed_plugins.json',
  });
  assert.equal(paths({}, '/h').link, '/h/.claude/fwd');
  assert.equal(
    paths({ CLAUDE_CODE_PLUGIN_CACHE_DIR: '/p' }, '/h').cache,
    '/p/cache',
  );
});

test('cacheEntry only names a fwd version folder inside the cache', () => {
  assert.deepEqual(cacheEntry('/c/m/fwd/0.1.2', '/c'), {
    marketplace: 'm',
    version: '0.1.2',
  });
  assert.equal(cacheEntry('/c/m/other/0.1.2', '/c'), null);
  assert.equal(cacheEntry('/c/m/fwd/0.1.2/skills', '/c'), null);
  assert.equal(cacheEntry('/elsewhere/m/fwd/0.1.2', '/c'), null);
});

test('an update re-points the link at the installed version', () => {
  const { p, dir } = machine();
  assert.equal(relink(p), dir('0.1.2'));
  assert.equal(readlinkSync(p.link), dir('0.1.2'));
  assert.equal(relink(p), null, 'already current: nothing to do');
});

test('versions compare as numbers, not strings', () => {
  // As strings "0.1.10" < "0.1.2", so a string compare would refuse this step.
  const { p, dir } = machine({ linked: '0.1.2', installed: '0.1.10' });
  assert.equal(relink(p), dir('0.1.10'));
});

test('a version that cannot be compared moves nothing, in either direction', () => {
  const a = machine({ installed: 'dev' });
  assert.equal(relink(a.p), null);
  assert.equal(readlinkSync(a.p.link), a.dir('0.1.1'));
  const b = machine({ linked: 'dev', installed: '0.1.2' });
  assert.equal(relink(b.p), null);
});

test('a link whose old version folder was swept is still re-pointed', () => {
  const { p, dir } = machine();
  rmSync(dir('0.1.1'), { recursive: true });
  assert.equal(relink(p), dir('0.1.2'));
});

test('never steps back to an older version', () => {
  const { p, dir, write } = machine();
  relink(p);
  write('0.1.1');
  assert.equal(plan(p), null);
  assert.equal(readlinkSync(p.link), dir('0.1.2'));
});

test('leaves alone a link that is not into the fwd cache', () => {
  const { p } = machine();
  const checkout = mkdtempSync(join(tmpdir(), 'checkout-'));
  rmSync(p.link);
  symlinkSync(checkout, p.link);
  assert.equal(relink(p), null);
  assert.equal(readlinkSync(p.link), checkout);
});

test('leaves alone a real folder, a missing link, or a missing install folder', () => {
  const a = machine();
  rmSync(a.p.link);
  assert.equal(relink(a.p), null, 'no link: switch.sh creates it, not this');
  mkdirSync(a.p.link);
  assert.equal(relink(a.p), null, 'a real folder is the user’s');

  const b = machine();
  rmSync(b.dir('0.1.2'), { recursive: true });
  assert.equal(relink(b.p), null);
  assert.equal(readlinkSync(b.p.link), b.dir('0.1.1'));
});

test('an unreadable or foreign install record changes nothing', () => {
  const a = machine();
  writeFileSync(a.p.installed, '{not json');
  assert.equal(relink(a.p), null);

  const b = machine();
  writeFileSync(
    b.p.installed,
    JSON.stringify({
      plugins: { 'fwd@fwd-stack': [{ scope: 'user', installPath: '/tmp' }] },
    }),
  );
  assert.equal(relink(b.p), null, 'an install path outside the cache');
  assert.equal(readlinkSync(b.p.link), b.dir('0.1.1'));
});

test('a project-only install never moves the per-user link', () => {
  const { p, dir } = machine();
  writeFileSync(
    p.installed,
    JSON.stringify({
      plugins: {
        'fwd@fwd-stack': [{ scope: 'project', installPath: dir('0.1.2') }],
      },
    }),
  );
  assert.equal(installedPath(p.installed, 'fwd-stack'), null);
  assert.equal(relink(p), null);
});

test('repoint never throws, and re-checks before the rename', () => {
  const { p, dir } = machine();
  mkdirSync(`${p.link}.tmp-${process.pid}`);
  assert.equal(
    repoint(p.link, dir('0.1.2')),
    false,
    'a folder on the temp name',
  );
  rmSync(`${p.link}.tmp-${process.pid}`, { recursive: true });
  assert.equal(
    repoint(p.link, dir('0.1.2'), () => false),
    false,
  );
  assert.equal(readlinkSync(p.link), dir('0.1.1'), 'a changed plan leaves it');
  assert.equal(repoint(p.link, dir('0.1.2')), true);
  assert.equal(readlinkSync(p.link), dir('0.1.2'));
});

test('the hook exits 0 and prints nothing', () => {
  const { p } = machine();
  const r = spawnSync(
    process.execPath,
    [new URL('./fwd-link.mjs', import.meta.url).pathname],
    {
      env: { ...process.env, CLAUDE_CONFIG_DIR: dirname(p.link) },
      encoding: 'utf8',
    },
  );
  assert.equal(r.status, 0);
  assert.equal(r.stdout + r.stderr, '');
  assert.match(readlinkSync(p.link), /0\.1\.2$/);
});

test('the user-scope install wins over a project one', () => {
  const { p, dir } = machine();
  writeFileSync(
    p.installed,
    JSON.stringify({
      plugins: {
        'fwd@fwd-stack': [
          { scope: 'project', installPath: dir('0.1.10') },
          { scope: 'user', installPath: dir('0.1.2') },
        ],
      },
    }),
  );
  assert.equal(relink(p), dir('0.1.2'));
});
