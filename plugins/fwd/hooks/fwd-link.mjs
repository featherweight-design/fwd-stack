#!/usr/bin/env node
// Keep <config>/fwd pointing at the installed plugin version, so an update needs no re-link.
//
// <config>/fwd (~/.claude/fwd by default) is the stable path that commands, docs and CLAUDE.md use
// for the plugin's scripts outside a hook. machine/switch.sh creates it once. Claude Code installs
// every version into its own folder, <plugins>/cache/<marketplace>/fwd/<version>, so after an
// update (by hand or by marketplace auto-update) the link would still name the old folder.
//
// SessionStart and UserPromptSubmit run this. It reads the version installed_plugins.json records
// for fwd@<marketplace> and re-points the link there, atomically (a new link renamed over the old).
// It only ever re-points a link it can vouch for, and otherwise changes nothing:
//   - the link exists and is a symlink (a real folder or file there is the user's);
//   - the link points into <plugins>/cache/<marketplace>/fwd/ (not a checkout, not elsewhere);
//   - the installed version is in the same marketplace's cache, and its folder exists;
//   - it never steps back to an older version when both versions compare.
// It prints nothing and always exits 0: a hook that cannot re-link must never block a prompt.
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import { isMain } from '../lib/is-main.mjs';
import { compareVersions } from '../skills/pr-review/gate-path.mjs';

export function paths(env = process.env, home = homedir()) {
  const config = env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  const plugins = env.CLAUDE_CODE_PLUGIN_CACHE_DIR || join(config, 'plugins');
  return {
    link: join(config, 'fwd'),
    cache: join(plugins, 'cache'),
    installed: join(plugins, 'installed_plugins.json'),
  };
}

// { marketplace, version } for a folder <cache>/<marketplace>/fwd/<version>, else null.
export function cacheEntry(dir, cache) {
  const parts = relative(cache, dir).split(sep);
  if (parts.length !== 3 || parts[0] === '..' || parts[0] === '') return null;
  if (parts[1] !== 'fwd' || parts[2] === '' || parts[2] === '..') return null;
  return { marketplace: parts[0], version: parts[2] };
}

// The user-scope fwd folder for one marketplace, from installed_plugins.json; null when absent.
// A project-scope install never moves the link: the link is per user.
export function installedPath(file, marketplace) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const rows = data?.plugins?.[`fwd@${marketplace}`];
  if (!Array.isArray(rows)) return null;
  const row = rows.find((r) => r?.scope === 'user');
  return typeof row?.installPath === 'string' ? row.installPath : null;
}

// What the link should point at now, or null to leave it alone. Never throws.
export function plan({ link, cache, installed }) {
  try {
    if (!lstatSync(link).isSymbolicLink()) return null;
    const realCache = realpathSync(cache);
    // The current target need not exist: an old version folder is swept 14 days after an update.
    // Its parent, <cache>/<marketplace>/fwd, stays, so that is resolved instead.
    const abs = resolve(dirname(link), readlinkSync(link));
    const current = cacheEntry(
      join(realpathSync(dirname(abs)), basename(abs)),
      realCache,
    );
    if (current === null) return null;
    const wanted = installedPath(installed, current.marketplace);
    if (wanted === null || !existsSync(wanted)) return null;
    const real = realpathSync(wanted);
    const next = cacheEntry(real, realCache);
    if (next === null || next.marketplace !== current.marketplace) return null;
    // Only forward: a version that is not newer, or cannot be compared, leaves the link alone.
    if (compareVersions(next.version, current.version) !== 1) return null;
    return real;
  } catch {
    return null;
  }
}

// Point the link at target in one step: a temporary link renamed over it. `stillWanted` is asked
// again just before the rename, so a session that planned from an older record does not undo a
// newer session's re-point (a window of a few microseconds remains; the next prompt corrects it).
export function repoint(link, target, stillWanted = () => true) {
  const tmp = `${link}.tmp-${process.pid}`;
  try {
    rmSync(tmp, { force: true });
    symlinkSync(target, tmp);
    if (!stillWanted()) throw new Error('changed');
    renameSync(tmp, link);
    return true;
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // A folder squatting on the temporary name is left for the user; never throw from a hook.
    }
    return false;
  }
}

export function relink(p = paths()) {
  const target = plan(p);
  if (target === null) return null;
  return repoint(p.link, target, () => plan(p) === target) ? target : null;
}

if (isMain(import.meta.url)) {
  relink();
  process.exit(0);
}
