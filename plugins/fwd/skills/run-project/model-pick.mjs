#!/usr/bin/env node
// The brief's `MODEL:` line for one PR, decided by rule so an orchestrator pastes it instead of
// choosing. Per PR, not per lane. Advisory at first (run-project §5).
//
//   node model-pick.mjs [--orchestrator] [--sonnet-failed "<what failed>"]
//                       [--subagent [--read-only]] [--json] <path> [<path>...]
//
// Paths are the PR's planned files, from its plan; with none given they are read from stdin, one
// per line. First rule that matches wins:
//   1. --orchestrator          opus
//   2. --sonnet-failed "..."   opus, naming the failed attempt
//   3. a path in money, auth, migrations or security (risk-override.mjs, MODEL_RISKY)   opus
//   4. --subagent              sonnet, or haiku with --read-only
//   5. otherwise               sonnet
// An opus answer (not rule 1) is queued when `orchestrator.maxOpusLanes` (default 1) Opus sessions
// are already running, counted from lane-context.mjs. When that read cannot see the model, the cap
// is skipped and the reason says so.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../../lib/fwd-config.mjs';
import { modelRiskOf } from '../pr-review/risk-override.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** Pure half of countOpus: Opus sessions other than this one, or null when none reports a model. */
export function opusIn(lanes, ownSession) {
  const others = lanes.filter((l) => l.session !== ownSession);
  if (!others.some((l) => l.model)) return null;
  return others.filter((l) => /opus/i.test(l.model ?? '')).length;
}

/** Opus sessions running now, or null when the transcripts cannot say. */
export function countOpus(env = process.env) {
  try {
    const out = execFileSync(
      'node',
      [join(here, '..', 'orchestrator', 'lane-context.mjs'), '--json'],
      {
        encoding: 'utf8',
        timeout: 20_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    return opusIn(JSON.parse(out), env.CLAUDE_SESSION_ID);
  } catch {
    return null;
  }
}

export function pick(
  { orchestrator, sonnetFailed, subagent, readOnly, paths = [] },
  { opusCount = countOpus, maxOpus } = {},
) {
  if (orchestrator) return { model: 'opus', reason: 'orchestrator' };
  let reason;
  if (sonnetFailed) {
    reason = `Sonnet already failed: ${sonnetFailed}`;
  } else {
    const hit = paths
      .map((p) => ({ p, category: modelRiskOf(p) }))
      .find((h) => h.category);
    if (hit) {
      reason = `${hit.category} path ${hit.p}`;
    } else if (subagent) {
      return readOnly
        ? { model: 'haiku', reason: 'read-only subagent' }
        : { model: 'sonnet', reason: 'subagent' };
    } else {
      return { model: 'sonnet', reason: 'default' };
    }
  }
  const max = maxOpus ?? loadConfig().orchestrator?.maxOpusLanes ?? 1;
  const used = opusCount();
  if (used === null)
    return {
      model: 'opus',
      reason: `${reason} (Opus slot cap not checked: session models unreadable)`,
    };
  return used >= max
    ? { model: 'opus', reason, queued: true, used, max }
    : { model: 'opus', reason, used, max };
}

export function line(r) {
  return r.queued
    ? `MODEL: opus (queued for the Opus slot: ${r.used}/${r.max} in use) — ${r.reason}`
    : `MODEL: ${r.model} — ${r.reason}`;
}

export function parseArgs(argv) {
  const o = { paths: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--orchestrator') o.orchestrator = true;
    else if (a === '--sonnet-failed') o.sonnetFailed = argv[++i] ?? '';
    else if (a === '--subagent') o.subagent = true;
    else if (a === '--read-only') o.readOnly = true;
    else if (a === '--json') o.json = true;
    else o.paths.push(a);
  }
  return o;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const o = parseArgs(process.argv.slice(2));
  if (o.paths.length === 0 && !process.stdin.isTTY) {
    try {
      o.paths = readFileSync(0, 'utf8')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      // no stdin: no paths
    }
  }
  const r = pick(o);
  console.log(o.json ? JSON.stringify(r, null, 2) : line(r));
}
