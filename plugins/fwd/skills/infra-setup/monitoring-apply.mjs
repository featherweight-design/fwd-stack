#!/usr/bin/env node
// Applies an app's monitoring spec to Sentry, PostHog and Better Stack Uptime (SKILL.md,
// "Monitoring dashboards by API"; schema in monitoring-spec.md).
//
//   node monitoring-apply.mjs [--spec .claude/fwd/monitoring.json] [--env-file <path>]
//                             [--only sentry|posthog|betterstack] [--apply]
//
// A dry run by default: it reads each vendor's current state and prints, per object, whether it
// would be created, updated or left unchanged. `--apply` makes those writes. It never deletes, and
// objects the spec does not name are left alone, so a second run reports everything unchanged.
//
// Tokens come only from the environment (FWD_SENTRY_TOKEN, FWD_POSTHOG_KEY, FWD_BETTERSTACK_TOKEN),
// optionally loaded from --env-file (default ~/.config/fwd/monitoring.env, outside any repo).
// Variables already set in the environment win over the file. No token or request header is ever
// printed; error text is passed through redact() first.
//
// The diffing is pure and lives in monitoring-core.mjs. This file is the HTTP layer; `fetch` is
// injected so monitoring-apply.test.mjs can run it against fixtures.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_HOSTS,
  ENV,
  PLANNERS,
  VENDORS,
  checkHost,
  formatPlan,
  parseArgs,
  parseEnvFile,
  redact,
  resolveRefs,
  validateSpec,
} from './monitoring-core.mjs';

export const DEFAULT_ENV_FILE = join(
  homedir(),
  '.config',
  'fwd',
  'monitoring.env',
);

/** A JSON client for one vendor. Errors name the method, path and status, never the headers. */
export function makeClient({ host, token, fetchImpl = globalThis.fetch }) {
  const call = async (method, pathOrUrl, body) => {
    const url = pathOrUrl.startsWith('http')
      ? pathOrUrl
      : `${host}${pathOrUrl}`;
    // A pagination link to another origin would carry the token there; refuse it.
    if (new URL(url).origin !== new URL(host).origin)
      throw new Error(
        `${method} ${url} refused: not on ${new URL(host).origin}`,
      );
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        // A redirect would replay the bearer token to wherever it points.
        redirect: 'error',
      });
    } catch (e) {
      throw new Error(
        redact(`${method} ${url} failed: ${e?.message ?? e}`, [token]),
      );
    }
    const text = await res.text();
    if (!res.ok)
      throw new Error(
        redact(
          `${method} ${url} answered ${res.status}: ${text.slice(0, 500)}`,
          [token],
        ),
      );
    return { data: text ? JSON.parse(text) : null, headers: res.headers };
  };
  return {
    get: (p) => call('GET', p),
    send: (method, p, body) => call(method, p, body),
  };
}

// The next page URL from Sentry's Link header, when it says more results exist.
export function sentryNext(link) {
  for (const part of String(link ?? '').split(',')) {
    if (/rel="next"/.test(part) && /results="true"/.test(part)) {
      const m = part.match(/<([^>]+)>/);
      if (m) return m[1];
    }
  }
  return null;
}

async function sentryState(client, cfg) {
  const org = encodeURIComponent(cfg.org);
  const titles = new Set((cfg.dashboards ?? []).map((d) => d.title));
  const list = [];
  let url = `/api/0/organizations/${org}/dashboards/?per_page=100`;
  while (url) {
    const { data, headers } = await client.get(url);
    list.push(...data);
    url = sentryNext(headers?.get?.('link'));
  }
  // The list carries no widgets, so read each dashboard the spec names in full.
  const dashboards = [];
  for (const d of list.filter((x) => titles.has(x.title)))
    dashboards.push(
      (await client.get(`/api/0/organizations/${org}/dashboards/${d.id}/`))
        .data,
    );
  return { dashboards };
}

// Every row of a PostHog list, following `next`.
async function posthogAll(client, path) {
  const out = [];
  let url = path;
  while (url) {
    const { data } = await client.get(url);
    out.push(...(data.results ?? []));
    url = data.next;
  }
  return out;
}

async function posthogState(client, cfg) {
  const base = `/api/projects/${encodeURIComponent(cfg.projectId)}`;
  const insights = [];
  for (const i of cfg.insights ?? []) {
    const q = new URLSearchParams({
      search: i.name,
      saved: 'true',
      limit: '100',
    });
    insights.push(
      ...(await posthogAll(client, `${base}/insights/?${q}`)).filter(
        (x) => x.name === i.name,
      ),
    );
  }
  const dashboards = [];
  for (const d of cfg.dashboards ?? []) {
    const q = new URLSearchParams({ search: d.name, limit: '100' });
    for (const hit of (
      await posthogAll(client, `${base}/dashboards/?${q}`)
    ).filter((x) => x.name === d.name))
      dashboards.push((await client.get(`${base}/dashboards/${hit.id}/`)).data);
  }
  return { insights, dashboards };
}

// Every row of a Better Stack list, following pagination.next.
async function betterstackAll(client, path) {
  const out = [];
  let url = `${path}${path.includes('?') ? '&' : '?'}per_page=250`;
  while (url) {
    const { data } = await client.get(url);
    out.push(...(data.data ?? []));
    url = data.pagination?.next ?? null;
  }
  return out;
}

async function betterstackState(client, cfg) {
  const pages = cfg.statusPages ?? [];
  const wantsMonitors = pages.some((p) =>
    (p.resources ?? []).some((r) => typeof r.monitor === 'string'),
  );
  const heartbeats = await betterstackAll(client, '/api/v2/heartbeats');
  const monitors = wantsMonitors
    ? await betterstackAll(client, '/api/v2/monitors')
    : [];
  const subdomains = new Set(pages.map((p) => p.subdomain));
  const statusPages = [];
  for (const p of await betterstackAll(client, '/api/v2/status-pages'))
    if (subdomains.has(p.attributes?.subdomain))
      statusPages.push({
        ...p,
        resources: await betterstackAll(
          client,
          `/api/v2/status-pages/${p.id}/resources`,
        ),
      });
  return { heartbeats, monitors, statusPages };
}

export const STATE = {
  sentry: sentryState,
  posthog: posthogState,
  betterstack: betterstackState,
};

/** Reads state and plans each vendor in the spec. Returns `{ steps, notes, clients }`. */
export async function plan(
  spec,
  { env, only = null, apply = false, allowHosts = [], fetchImpl },
) {
  const steps = [];
  const notes = [];
  const clients = {};
  const selected = VENDORS.filter((v) => spec[v] && (!only || only === v));
  // Every host is checked before the first request, so a bad one stops the run with nothing sent.
  const hosts = Object.fromEntries(
    selected.map((v) => [
      v,
      checkHost(v, spec[v].host ?? DEFAULT_HOSTS[v], allowHosts),
    ]),
  );
  for (const vendor of selected) {
    const cfg = spec[vendor];
    const token = env[ENV[vendor]];
    if (!token) {
      if (apply)
        throw new Error(
          `${ENV[vendor]} is not set; it is needed to apply the ${vendor} section`,
        );
      notes.push(`skipped   ${vendor}: ${ENV[vendor]} is not set`);
      continue;
    }
    const client = makeClient({
      host: hosts[vendor],
      token,
      fetchImpl,
    });
    clients[vendor] = client;
    steps.push(...PLANNERS[vendor](cfg, await STATE[vendor](client, cfg)));
  }
  return { steps, notes, clients };
}

const label = (s) => `${s.vendor} ${s.type} "${s.name}"`;

/**
 * Runs the plan's writes in order, filling in ids created by earlier steps. Stops at the first
 * failure and logs what was done, where it failed and what did not run. Returns
 * `{ done, failed, notRun }`, with `failed` null when every write went through.
 */
export async function applyPlan(steps, clients, log = () => {}) {
  const ids = new Map();
  const writes = steps.filter((s) => s.request);
  const done = [];
  let failed = null;
  for (const s of writes) {
    try {
      const path = resolveRefs(s.request.path, ids);
      const body = resolveRefs(s.request.body, ids);
      const { data } = await clients[s.vendor].send(
        s.request.method,
        path,
        body,
      );
      if (s.action === 'create') {
        const id = data?.data?.id ?? data?.id;
        if (id === undefined || id === null)
          throw new Error(`${s.request.method} ${path} returned no id`);
        if (s.saveAs) ids.set(s.saveAs, id);
      }
      done.push(s);
      log(`${s.action === 'create' ? 'created' : 'updated'}   ${label(s)}`);
    } catch (e) {
      failed = { step: s, message: String(e?.message ?? e) };
      break;
    }
  }
  const notRun = writes.slice(done.length + (failed ? 1 : 0));
  if (failed) {
    log(`failed    ${label(failed.step)}: ${failed.message}`);
    for (const s of notRun) log(`not run   ${label(s)}`);
    log(
      `${done.length} done, failed at ${label(failed.step)}, ${notRun.length} not run`,
    );
  } else log(`${done.length} done, 0 failed, 0 not run`);
  return { done, failed, notRun };
}

/** The environment with the env file's values added where a variable is not already set. */
export function loadEnv(envFile, env = process.env) {
  const path = envFile ?? DEFAULT_ENV_FILE;
  if (!existsSync(path)) {
    if (envFile) throw new Error(`env file not found: ${envFile}`);
    return { ...env };
  }
  return { ...parseEnvFile(readFileSync(path, 'utf8')), ...env };
}

const executed = (() => {
  try {
    return (
      Boolean(process.argv[1]) &&
      realpathSync(process.argv[1]) ===
        realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
})();

if (executed) {
  let secrets = [];
  try {
    const args = parseArgs(process.argv.slice(2));
    const specPath = resolve(args.spec);
    if (!existsSync(specPath)) throw new Error(`spec not found: ${args.spec}`);
    const spec = JSON.parse(readFileSync(specPath, 'utf8'));
    const errs = validateSpec(spec);
    if (errs.length)
      throw new Error(`the spec has problems:\n- ${errs.join('\n- ')}`);
    const env = loadEnv(args.envFile);
    secrets = Object.values(ENV).map((k) => env[k]);
    const { steps, notes, clients } = await plan(spec, {
      env,
      only: args.only,
      apply: args.apply,
      allowHosts: args.allowHosts,
    });
    console.log(formatPlan(steps, notes));
    if (args.apply) {
      const { failed } = await applyPlan(steps, clients, (line) =>
        console.log(redact(line, secrets)),
      );
      if (failed) process.exit(1);
    } else if (steps.some((s) => s.request))
      console.log('dry run: nothing written; re-run with --apply');
  } catch (e) {
    console.error(redact(e?.message ?? e, secrets));
    process.exit(1);
  }
}
