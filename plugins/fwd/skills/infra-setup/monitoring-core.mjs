// The pure half of monitoring-apply.mjs: argument and env-file parsing, spec checks, and the
// planners that diff a monitoring spec against state already fetched from Sentry, PostHog and
// Better Stack. Nothing here touches the network or the environment, so every rule is tested with
// plain fixtures (monitoring-apply.test.mjs). The schema is documented in monitoring-spec.md.
//
// A plan is a list of steps. Each step names the object and what would happen to it:
//   { vendor, type, name, action: 'create'|'update'|'unchanged'|'skip', changes?, note?,
//     request?: { method, path, body }, saveAs? }
// A step that creates an object other steps point at carries `saveAs`; those later steps write
// `{ "$ref": key }` in a body, or `{{key}}` in a path, and the applier fills in the created id.
// Planners never emit a DELETE: objects that are not in the spec are left alone.

export const ENV = {
  sentry: 'FWD_SENTRY_TOKEN',
  posthog: 'FWD_POSTHOG_KEY',
  betterstack: 'FWD_BETTERSTACK_TOKEN',
};
export const VENDORS = Object.keys(ENV);
export const DEFAULT_SPEC = '.claude/fwd/monitoring.json';
export const DEFAULT_HOSTS = {
  sentry: 'https://sentry.io',
  posthog: 'https://us.posthog.com',
  betterstack: 'https://incidents.betterstack.com',
};

// The only hosts a token is sent to, unless --allow-host names another. https only.
export const ALLOWED_HOSTS = {
  sentry: (h) => h === 'sentry.io' || h.endsWith('.sentry.io'),
  posthog: (h) =>
    [
      'us.posthog.com',
      'eu.posthog.com',
      'us.i.posthog.com',
      'eu.i.posthog.com',
    ].includes(h),
  betterstack: (h) =>
    ['incidents.betterstack.com', 'uptime.betterstack.com'].includes(h),
};

/** The vendor's API origin, or throws when the host is not https on the allowlist or --allow-host. */
export function checkHost(vendor, host, allowHosts = []) {
  let u;
  try {
    u = new URL(host);
  } catch {
    throw new Error(`${vendor}.host is not a URL: ${host}`);
  }
  if (u.protocol !== 'https:')
    throw new Error(`${vendor}.host must use https: ${u.origin}`);
  if (
    u.username ||
    u.password ||
    u.port ||
    u.search ||
    u.hash ||
    u.pathname !== '/'
  )
    throw new Error(`${vendor}.host must be a bare https origin: ${host}`);
  if (!ALLOWED_HOSTS[vendor](u.hostname) && !allowHosts.includes(u.hostname))
    throw new Error(
      `${vendor}.host ${u.hostname} is not a known ${vendor} API host; pass --allow-host ${u.hostname} if it is yours`,
    );
  return u.origin;
}

const USAGE = `usage: node monitoring-apply.mjs [--spec ${DEFAULT_SPEC}] [--env-file <path>] [--only sentry|posthog|betterstack] [--allow-host <host>]... [--apply]`;

/** `{ spec, envFile, only, allowHosts, apply }` from argv (without node and the script), or throws with the usage. */
export function parseArgs(argv) {
  const out = {
    spec: DEFAULT_SPEC,
    envFile: null,
    only: null,
    allowHosts: [],
    apply: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (
      a === '--spec' ||
      a === '--env-file' ||
      a === '--only' ||
      a === '--allow-host'
    ) {
      const v = argv[++i];
      if (!v || v.startsWith('--'))
        throw new Error(`${a} needs a value\n${USAGE}`);
      if (a === '--spec') out.spec = v;
      else if (a === '--env-file') out.envFile = v;
      else if (a === '--allow-host') out.allowHosts.push(v.toLowerCase());
      else if (!VENDORS.includes(v))
        throw new Error(
          `--only must be one of ${VENDORS.join(', ')}\n${USAGE}`,
        );
      else out.only = v;
    } else throw new Error(`unknown argument: ${a}\n${USAGE}`);
  }
  return out;
}

/** KEY=VALUE pairs from an env file's text. Blank lines, `#` comments and `export ` are allowed. */
export function parseEnvFile(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, '');
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    let value = line.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

/** Replaces every given secret in a string with `[redacted]`, and any bearer credential too. */
export function redact(text, secrets = []) {
  let s = String(text);
  for (const v of secrets)
    if (v && v.length >= 4) s = s.split(v).join('[redacted]');
  return s.replace(/(Bearer\s+)[^\s"']+/gi, '$1[redacted]');
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** True when every value the spec states is equal in `have`; fields the vendor adds are ignored. */
export function subsetEqual(want, have) {
  if (Array.isArray(want))
    return (
      Array.isArray(have) &&
      have.length === want.length &&
      want.every((w, i) => subsetEqual(w, have[i]))
    );
  if (isObj(want))
    return (
      isObj(have) &&
      Object.keys(want).every((k) => subsetEqual(want[k], have[k]))
    );
  return want === have;
}

/**
 * The top-level keys of `want` whose values differ from `have`. Keys in `writeOnly` are fields the
 * vendor accepts but never reads back, so they are not compared (they would differ every run).
 */
export function changedKeys(want, have, writeOnly = []) {
  return Object.keys(want).filter(
    (k) => !writeOnly.includes(k) && !subsetEqual(want[k], have?.[k]),
  );
}

// Fields each object type accepts but does not return; sent on create and with any update.
export const WRITE_ONLY = {
  posthogInsight: ['tags'],
  posthogDashboard: ['tags'],
  heartbeat: ['team_name'],
  statusPage: ['password'],
};

const updateBody = (want, changes, writeOnly) =>
  pick(want, [...changes, ...writeOnly]);

function pick(obj, keys) {
  return Object.fromEntries(
    keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]),
  );
}

/** A list of human-readable problems with the spec; empty when it is usable. */
export function validateSpec(spec) {
  const errs = [];
  if (!isObj(spec)) return ['the spec must be a JSON object'];
  for (const k of Object.keys(spec))
    if (!VENDORS.includes(k) && k !== '$schema' && k !== 'app')
      errs.push(`unknown top-level key "${k}"`);
  const names = (list, field, where) => {
    const seen = new Set();
    for (const [i, item] of (list ?? []).entries()) {
      const n = item?.[field];
      if (typeof n !== 'string' || !n)
        errs.push(`${where}[${i}] needs a "${field}"`);
      else if (seen.has(n)) errs.push(`${where} lists "${n}" twice`);
      else seen.add(n);
    }
  };
  const { sentry, posthog, betterstack } = spec;
  if (sentry) {
    if (!sentry.org) errs.push('sentry.org is required');
    names(sentry.dashboards, 'title', 'sentry.dashboards');
    for (const d of sentry.dashboards ?? [])
      names(d.widgets, 'title', `sentry dashboard "${d.title}" widgets`);
  }
  if (posthog) {
    if (posthog.projectId === undefined)
      errs.push('posthog.projectId is required');
    names(posthog.insights, 'name', 'posthog.insights');
    for (const i of posthog.insights ?? [])
      if (!isObj(i.query))
        errs.push(`posthog insight "${i.name}" needs a "query" object`);
    names(posthog.dashboards, 'name', 'posthog.dashboards');
  }
  if (betterstack) {
    names(betterstack.heartbeats, 'name', 'betterstack.heartbeats');
    names(betterstack.statusPages, 'subdomain', 'betterstack.statusPages');
    for (const p of betterstack.statusPages ?? []) {
      names(
        p.resources,
        'public_name',
        `status page "${p.subdomain}" resources`,
      );
      for (const r of p.resources ?? [])
        if ((r.monitor === undefined) === (r.heartbeat === undefined))
          errs.push(
            `status page "${p.subdomain}" resource "${r.public_name}" needs exactly one of "monitor" or "heartbeat"`,
          );
    }
  }
  return errs;
}

// One existing object by name, or a skip note when the vendor holds several with that name.
function matchOne(list, key, name) {
  const hits = list.filter((x) => x[key] === name);
  if (hits.length > 1)
    return {
      ambiguous: `${hits.length} objects share this name; rename one by hand, then re-run`,
    };
  return { hit: hits[0] };
}

const step = (vendor, type, name, rest) => ({ vendor, type, name, ...rest });

// ---------------------------------------------------------------------------------------------
// Sentry: organization dashboards, matched by title.
// state: { dashboards: [full dashboard objects, widgets included] }

const SENTRY_DASHBOARD_FIELDS = [
  'title',
  'projects',
  'environment',
  'period',
  'filters',
  'utc',
];

export function planSentry(cfg, state) {
  const base = `/api/0/organizations/${encodeURIComponent(cfg.org)}/dashboards/`;
  return (cfg.dashboards ?? []).map((d) => {
    const want = pick(d, SENTRY_DASHBOARD_FIELDS);
    const widgets = d.widgets ?? [];
    const { hit, ambiguous } = matchOne(state.dashboards, 'title', d.title);
    if (ambiguous)
      return step('sentry', 'dashboard', d.title, {
        action: 'skip',
        note: ambiguous,
      });
    if (!hit)
      return step('sentry', 'dashboard', d.title, {
        action: 'create',
        request: { method: 'POST', path: base, body: { ...want, widgets } },
      });
    // Widgets are matched by title inside the dashboard. A widget that exists but is not in the
    // spec is sent back as it is, so the PUT keeps it rather than dropping it.
    const existing = hit.widgets ?? [];
    const changes = changedKeys(want, hit);
    const merged = existing.map((w) => {
      const s = widgets.find((x) => x.title === w.title);
      if (!s) return w;
      if (!subsetEqual(s, w)) changes.push(`widget "${s.title}"`);
      return mergeWidget(w, s);
    });
    for (const s of widgets)
      if (!existing.some((w) => w.title === s.title)) {
        changes.push(`widget "${s.title}" (new)`);
        merged.push(s);
      }
    if (changes.length === 0)
      return step('sentry', 'dashboard', d.title, { action: 'unchanged' });
    return step('sentry', 'dashboard', d.title, {
      action: 'update',
      changes,
      request: {
        method: 'PUT',
        path: `${base}${hit.id}/`,
        body: { ...keepPageFilters(want, hit), widgets: merged },
      },
    });
  });
}

// Sentry rebuilds a dashboard's whole saved-filter set when an edit sends any of projects,
// environment, period, start, end, utc or filters (update_dashboard_filters assigns
// `instance.filters = filters`). So when the spec sets any of them, the fields it leaves out are
// copied from the live dashboard: the "all projects" setting (projects [-1]), environment, the
// time range, utc, and filters such as release and the global filter.
const SENTRY_FILTER_KEYS = [
  'projects',
  'environment',
  'period',
  'start',
  'end',
  'utc',
  'filters',
];
export function keepPageFilters(want, live) {
  if (!SENTRY_FILTER_KEYS.some((k) => k in want)) return want;
  const out = { ...want };
  for (const k of ['projects', 'environment', 'utc'])
    if (!(k in out) && live[k] != null) out[k] = live[k];
  // period and start/end are one time range: keep the live one only if the spec sets neither.
  if (!['period', 'start', 'end'].some((k) => k in want))
    for (const k of ['period', 'start', 'end'])
      if (live[k] != null) out[k] = live[k];
  if (want.filters || (live.filters && Object.keys(live.filters).length))
    out.filters = { ...(live.filters ?? {}), ...(want.filters ?? {}) };
  return out;
}

// The spec's widget over the existing one, keeping the ids Sentry needs to update in place.
function mergeWidget(existing, spec) {
  const out = { ...existing, ...spec, id: existing.id };
  if (spec.queries)
    out.queries = spec.queries.map((q, i) =>
      existing.queries?.[i]?.id === undefined
        ? q
        : { ...q, id: existing.queries[i].id },
    );
  return out;
}

// ---------------------------------------------------------------------------------------------
// PostHog: saved insights and dashboards, matched by name.
// state: { insights: [insight objects with query], dashboards: [dashboard objects with tiles] }

const POSTHOG_INSIGHT_FIELDS = ['name', 'description', 'tags', 'query'];
const POSTHOG_DASHBOARD_FIELDS = ['name', 'description', 'tags', 'pinned'];

export function planPosthog(cfg, state) {
  const base = `/api/projects/${encodeURIComponent(cfg.projectId)}`;
  const steps = [];
  const insightIds = new Map(); // spec insight name -> id, or a $ref when created in this run
  for (const i of cfg.insights ?? []) {
    const want = pick(i, POSTHOG_INSIGHT_FIELDS);
    const live = state.insights.filter((x) => !x.deleted);
    const { hit, ambiguous } = matchOne(live, 'name', i.name);
    if (ambiguous) {
      steps.push(
        step('posthog', 'insight', i.name, { action: 'skip', note: ambiguous }),
      );
      continue;
    }
    if (!hit) {
      const ref = `posthog-insight:${i.name}`;
      insightIds.set(i.name, { $ref: ref });
      steps.push(
        step('posthog', 'insight', i.name, {
          action: 'create',
          saveAs: ref,
          request: {
            method: 'POST',
            path: `${base}/insights/`,
            body: { ...want, saved: true },
          },
        }),
      );
      continue;
    }
    insightIds.set(i.name, hit.id);
    const changes = changedKeys(want, hit, WRITE_ONLY.posthogInsight);
    steps.push(
      changes.length === 0
        ? step('posthog', 'insight', i.name, { action: 'unchanged' })
        : step('posthog', 'insight', i.name, {
            action: 'update',
            changes,
            request: {
              method: 'PATCH',
              path: `${base}/insights/${hit.id}/`,
              body: updateBody(want, changes, WRITE_ONLY.posthogInsight),
            },
          }),
    );
  }
  for (const d of cfg.dashboards ?? []) {
    const want = pick(d, POSTHOG_DASHBOARD_FIELDS);
    const live = state.dashboards.filter((x) => !x.deleted);
    const { hit, ambiguous } = matchOne(live, 'name', d.name);
    if (ambiguous) {
      steps.push(
        step('posthog', 'dashboard', d.name, {
          action: 'skip',
          note: ambiguous,
        }),
      );
      continue;
    }
    let dashId = hit?.id;
    if (!hit) {
      dashId = `{{posthog-dashboard:${d.name}}}`;
      steps.push(
        step('posthog', 'dashboard', d.name, {
          action: 'create',
          saveAs: `posthog-dashboard:${d.name}`,
          request: { method: 'POST', path: `${base}/dashboards/`, body: want },
        }),
      );
    } else {
      const changes = changedKeys(want, hit, WRITE_ONLY.posthogDashboard);
      steps.push(
        changes.length === 0
          ? step('posthog', 'dashboard', d.name, { action: 'unchanged' })
          : step('posthog', 'dashboard', d.name, {
              action: 'update',
              changes,
              request: {
                method: 'PATCH',
                path: `${base}/dashboards/${hit.id}/`,
                body: updateBody(want, changes, WRITE_ONLY.posthogDashboard),
              },
            }),
      );
    }
    // Tiles are only ever added. A tile on the dashboard that the spec does not name stays.
    const onBoard = new Set(
      (hit?.tiles ?? []).map((t) => t?.insight?.id).filter(Boolean),
    );
    for (const name of d.insights ?? []) {
      const label = `${d.name} / ${name}`;
      const id = insightIds.get(name);
      if (id === undefined)
        steps.push(
          step('posthog', 'tile', label, {
            action: 'skip',
            note: `no insight named "${name}" in the spec (or it was skipped)`,
          }),
        );
      else if (typeof id === 'number' && onBoard.has(id))
        steps.push(step('posthog', 'tile', label, { action: 'unchanged' }));
      else
        steps.push(
          step('posthog', 'tile', label, {
            action: 'create',
            request: {
              method: 'POST',
              path: `${base}/dashboards/${dashId}/add_insight/`,
              body: { insight_id: id },
            },
          }),
        );
    }
  }
  return steps;
}

// ---------------------------------------------------------------------------------------------
// Better Stack Uptime: heartbeats (by name), status pages (by subdomain) and their resources (by
// public_name). A resource points at a monitor or heartbeat by name or by numeric id.
// state: { heartbeats, monitors, statusPages: [{ id, attributes, resources: [...] }] } (JSON:API)

const STATUS_PAGE_FIELDS = (p) =>
  Object.keys(p).filter((k) => k !== 'resources' && p[k] !== undefined);

export function planBetterstack(cfg, state) {
  const steps = [];
  const heartbeatIds = new Map();
  for (const h of cfg.heartbeats ?? []) {
    const { hit, ambiguous } = matchOne(
      state.heartbeats.map((x) => ({ ...x.attributes, id: x.id })),
      'name',
      h.name,
    );
    if (ambiguous) {
      steps.push(
        step('betterstack', 'heartbeat', h.name, {
          action: 'skip',
          note: ambiguous,
        }),
      );
      continue;
    }
    if (!hit) {
      const ref = `betterstack-heartbeat:${h.name}`;
      heartbeatIds.set(h.name, { $ref: ref });
      steps.push(
        step('betterstack', 'heartbeat', h.name, {
          action: 'create',
          saveAs: ref,
          request: { method: 'POST', path: '/api/v2/heartbeats', body: h },
        }),
      );
      continue;
    }
    heartbeatIds.set(h.name, hit.id);
    const changes = changedKeys(h, hit, WRITE_ONLY.heartbeat);
    steps.push(
      changes.length === 0
        ? step('betterstack', 'heartbeat', h.name, { action: 'unchanged' })
        : step('betterstack', 'heartbeat', h.name, {
            action: 'update',
            changes,
            request: {
              method: 'PATCH',
              path: `/api/v2/heartbeats/${hit.id}`,
              body: updateBody(h, changes, WRITE_ONLY.heartbeat),
            },
          }),
    );
  }

  const resolve = (kind, ref) => {
    if (typeof ref === 'number') return { id: String(ref) };
    if (kind === 'Heartbeat') {
      if (heartbeatIds.has(ref)) return { id: heartbeatIds.get(ref) };
      const hits = state.heartbeats.filter((x) => x.attributes?.name === ref);
      if (hits.length === 1) return { id: hits[0].id };
      return {
        error: `${hits.length ? 'several' : 'no'} heartbeats named "${ref}"`,
      };
    }
    const hits = state.monitors.filter(
      (x) => x.attributes?.pronounceable_name === ref,
    );
    if (hits.length === 1) return { id: hits[0].id };
    return {
      error: `${hits.length ? 'several' : 'no'} monitors named "${ref}"`,
    };
  };

  for (const p of cfg.statusPages ?? []) {
    const want = pick(p, STATUS_PAGE_FIELDS(p));
    const pages = state.statusPages.map((x) => ({
      ...x.attributes,
      id: x.id,
      resources: x.resources,
    }));
    const { hit, ambiguous } = matchOne(pages, 'subdomain', p.subdomain);
    if (ambiguous) {
      steps.push(
        step('betterstack', 'status page', p.subdomain, {
          action: 'skip',
          note: ambiguous,
        }),
      );
      continue;
    }
    let pageId = hit?.id;
    if (!hit) {
      pageId = `{{betterstack-page:${p.subdomain}}}`;
      steps.push(
        step('betterstack', 'status page', p.subdomain, {
          action: 'create',
          saveAs: `betterstack-page:${p.subdomain}`,
          request: { method: 'POST', path: '/api/v2/status-pages', body: want },
        }),
      );
    } else {
      const changes = changedKeys(want, hit, WRITE_ONLY.statusPage);
      steps.push(
        changes.length === 0
          ? step('betterstack', 'status page', p.subdomain, {
              action: 'unchanged',
            })
          : step('betterstack', 'status page', p.subdomain, {
              action: 'update',
              changes,
              request: {
                method: 'PATCH',
                path: `/api/v2/status-pages/${hit.id}`,
                body: updateBody(want, changes, WRITE_ONLY.statusPage),
              },
            }),
      );
    }
    const existing = (hit?.resources ?? []).map((x) => ({
      ...x.attributes,
      id: x.id,
    }));
    for (const r of p.resources ?? []) {
      const label = `${p.subdomain} / ${r.public_name}`;
      const resource_type = r.heartbeat !== undefined ? 'Heartbeat' : 'Monitor';
      const target = resolve(resource_type, r.heartbeat ?? r.monitor);
      if (target.error) {
        steps.push(
          step('betterstack', 'resource', label, {
            action: 'skip',
            note: target.error,
          }),
        );
        continue;
      }
      const attrs = Object.fromEntries(
        Object.entries(r).filter(([k]) => k !== 'monitor' && k !== 'heartbeat'),
      );
      const body = { ...attrs, resource_type, resource_id: target.id };
      const { hit: res, ambiguous: amb } = matchOne(
        existing,
        'public_name',
        r.public_name,
      );
      if (amb) {
        steps.push(
          step('betterstack', 'resource', label, { action: 'skip', note: amb }),
        );
        continue;
      }
      if (!res) {
        steps.push(
          step('betterstack', 'resource', label, {
            action: 'create',
            request: {
              method: 'POST',
              path: `/api/v2/status-pages/${pageId}/resources`,
              body,
            },
          }),
        );
        continue;
      }
      // Better Stack returns resource_id as a number; compare as strings.
      const have = {
        ...res,
        resource_id: res.resource_id == null ? null : String(res.resource_id),
      };
      const changes = changedKeys(body, have);
      // The API asks for resource_type and resource_id to be sent together.
      if (changes.includes('resource_id') || changes.includes('resource_type'))
        for (const k of ['resource_type', 'resource_id'])
          if (!changes.includes(k)) changes.push(k);
      steps.push(
        changes.length === 0
          ? step('betterstack', 'resource', label, { action: 'unchanged' })
          : step('betterstack', 'resource', label, {
              action: 'update',
              changes,
              request: {
                method: 'PATCH',
                path: `/api/v2/status-pages/${pageId}/resources/${res.id}`,
                body: pick(body, changes),
              },
            }),
      );
    }
  }
  return steps;
}

export const PLANNERS = {
  sentry: planSentry,
  posthog: planPosthog,
  betterstack: planBetterstack,
};

// ---------------------------------------------------------------------------------------------

/** Fills `{{key}}` in a path and `{ "$ref": key }` in a body from ids created earlier in the run. */
export function resolveRefs(value, ids) {
  const look = (key) => {
    if (!ids.has(key))
      throw new Error(`no id recorded for ${key}; an earlier step did not run`);
    return ids.get(key);
  };
  if (typeof value === 'string')
    return value.replace(/\{\{([^}]+)\}\}/g, (_, key) => String(look(key)));
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, ids));
  if (isObj(value)) {
    if (Object.keys(value).length === 1 && typeof value.$ref === 'string')
      return look(value.$ref);
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolveRefs(v, ids)]),
    );
  }
  return value;
}

/** The plan as text, one line per object, with totals. */
export function formatPlan(steps, notes = []) {
  const lines = [...notes];
  for (const s of steps) {
    const detail = s.note
      ? ` (${s.note})`
      : s.changes?.length
        ? ` (${s.changes.join(', ')})`
        : '';
    lines.push(
      `${s.action.padEnd(9)} ${s.vendor} ${s.type} "${s.name}"${detail}`,
    );
  }
  const count = (a) => steps.filter((s) => s.action === a).length;
  lines.push(
    `${count('create')} to create, ${count('update')} to update, ${count('unchanged')} unchanged, ${count('skip')} skipped`,
  );
  return lines.join('\n');
}
