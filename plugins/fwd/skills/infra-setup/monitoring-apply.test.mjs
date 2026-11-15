// node --test monitoring-apply.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  applyPlan,
  loadEnv,
  makeClient,
  plan,
  sentryNext,
} from './monitoring-apply.mjs';
import {
  formatPlan,
  parseArgs,
  parseEnvFile,
  planBetterstack,
  planPosthog,
  planSentry,
  redact,
  resolveRefs,
  subsetEqual,
  validateSpec,
} from './monitoring-core.mjs';

const example = JSON.parse(
  readFileSync(new URL('./monitoring.example.json', import.meta.url), 'utf8'),
);
const clone = (v) => structuredClone(v);
const TOKENS = {
  FWD_SENTRY_TOKEN: 'sntrys_fake_sentry_token',
  FWD_POSTHOG_KEY: 'phx_fake_posthog_key',
  FWD_BETTERSTACK_TOKEN: 'fake_betterstack_token',
};

test('parseArgs defaults to a dry run of the app spec', () => {
  assert.deepEqual(parseArgs([]), {
    spec: '.claude/fwd/monitoring.json',
    envFile: null,
    only: null,
    apply: false,
  });
  assert.deepEqual(
    parseArgs(['--only', 'posthog', '--apply', '--spec', 'x.json']),
    { spec: 'x.json', envFile: null, only: 'posthog', apply: true },
  );
  assert.throws(() => parseArgs(['--only', 'datadog']), /--only must be/);
  assert.throws(() => parseArgs(['--spec']), /needs a value/);
  assert.throws(() => parseArgs(['--force']), /unknown argument/);
});

test('parseEnvFile reads KEY=VALUE lines, comments, export and quotes', () => {
  assert.deepEqual(
    parseEnvFile(
      '# tokens\nexport A=1\nB="two words"\n\nC=\'x=y\'\nnot a pair\n',
    ),
    { A: '1', B: 'two words', C: 'x=y' },
  );
});

test('loadEnv lets the environment win and refuses a named file that is missing', () => {
  assert.throws(
    () => loadEnv('/nonexistent/fwd-monitoring.env', {}),
    /not found/,
  );
  const env = loadEnv(null, { FWD_SENTRY_TOKEN: 'from-env' });
  assert.equal(env.FWD_SENTRY_TOKEN, 'from-env');
});

test('redact removes known secrets and any bearer credential', () => {
  const out = redact(
    'failed with abc123secret and Authorization: Bearer xyz.987',
    ['abc123secret'],
  );
  assert.ok(!out.includes('abc123secret'));
  assert.ok(!out.includes('xyz.987'));
});

test('subsetEqual ignores fields the vendor adds but not changed ones', () => {
  assert.ok(
    subsetEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2, c: 3 }], d: 4 }),
  );
  assert.ok(!subsetEqual({ a: [1] }, { a: [1, 2] }));
  assert.ok(!subsetEqual({ a: { b: 2 } }, { a: { b: 3 } }));
});

test('validateSpec accepts the example and names problems in a bad spec', () => {
  assert.deepEqual(validateSpec(example), []);
  const errs = validateSpec({
    sentry: { dashboards: [{ title: 'A' }, { title: 'A' }] },
    posthog: { insights: [{ name: 'I' }] },
    betterstack: {
      statusPages: [{ subdomain: 's', resources: [{ public_name: 'r' }] }],
    },
    datadog: {},
  });
  assert.ok(errs.some((e) => /sentry.org/.test(e)));
  assert.ok(errs.some((e) => /"A" twice/.test(e)));
  assert.ok(errs.some((e) => /projectId/.test(e)));
  assert.ok(errs.some((e) => /"query" object/.test(e)));
  assert.ok(errs.some((e) => /exactly one of/.test(e)));
  assert.ok(errs.some((e) => /datadog/.test(e)));
});

test('planSentry creates a missing dashboard and leaves a matching one unchanged', () => {
  const cfg = example.sentry;
  const [create] = planSentry(cfg, { dashboards: [] });
  assert.equal(create.action, 'create');
  assert.equal(create.request.method, 'POST');
  assert.equal(create.request.path, '/api/0/organizations/acme/dashboards/');
  const live = { id: '9', ...clone(create.request.body) };
  live.widgets = live.widgets.map((w, i) => ({
    ...w,
    id: String(i),
    dateCreated: 'x',
  }));
  assert.equal(planSentry(cfg, { dashboards: [live] })[0].action, 'unchanged');
});

test('planSentry updates a changed widget and keeps widgets the spec does not name', () => {
  const cfg = example.sentry;
  const body = planSentry(cfg, { dashboards: [] })[0].request.body;
  const live = {
    id: '9',
    ...clone(body),
    widgets: [
      { ...clone(body.widgets[0]), id: '1', interval: '5m' },
      { id: '2', title: 'Hand-made widget', displayType: 'big_number' },
    ],
  };
  const [s] = planSentry(cfg, { dashboards: [live] });
  assert.equal(s.action, 'update');
  assert.equal(s.request.method, 'PUT');
  assert.equal(s.request.path, '/api/0/organizations/acme/dashboards/9/');
  const titles = s.request.body.widgets.map((w) => w.title);
  assert.deepEqual(titles, [
    'Errors per hour',
    'Hand-made widget',
    'Top issues',
  ]);
  assert.equal(s.request.body.widgets[0].id, '1');
  assert.equal(s.request.body.widgets[0].interval, '1h');
  assert.ok(s.changes.includes('widget "Errors per hour"'));
  assert.ok(s.changes.includes('widget "Top issues" (new)'));
});

test('planSentry skips a title the org holds twice', () => {
  const two = [
    { id: '1', title: 'Acme: errors' },
    { id: '2', title: 'Acme: errors' },
  ];
  assert.equal(
    planSentry(example.sentry, { dashboards: two })[0].action,
    'skip',
  );
});

test('planPosthog creates insights, the dashboard and its tiles with refs', () => {
  const steps = planPosthog(example.posthog, { insights: [], dashboards: [] });
  assert.deepEqual(
    steps.map((s) => `${s.action} ${s.type}`),
    [
      'create insight',
      'create insight',
      'create dashboard',
      'create tile',
      'create tile',
    ],
  );
  assert.equal(steps[0].request.body.saved, true);
  const tile = steps[3];
  assert.equal(
    tile.request.path,
    '/api/projects/1/dashboards/{{posthog-dashboard:Acme: growth}}/add_insight/',
  );
  assert.deepEqual(tile.request.body, {
    insight_id: { $ref: 'posthog-insight:Acme: sign-up funnel' },
  });
});

test('planPosthog patches only changed fields and adds only missing tiles', () => {
  const [funnel, daily] = example.posthog.insights;
  const state = {
    insights: [
      { id: 11, ...clone(funnel), description: 'old', result: [] },
      { id: 12, ...clone(daily) },
      { id: 99, name: 'Acme: daily sign-ups', deleted: true },
    ],
    dashboards: [
      {
        id: 5,
        name: 'Acme: growth',
        description: 'Sign-ups at a glance.',
        tiles: [{ insight: { id: 11 } }, { insight: { id: 40 } }],
      },
    ],
  };
  const steps = planPosthog(example.posthog, state);
  assert.deepEqual(
    steps.map((s) => `${s.action} ${s.type}`),
    [
      'update insight',
      'unchanged insight',
      'unchanged dashboard',
      'unchanged tile',
      'create tile',
    ],
  );
  assert.deepEqual(steps[0].request.body, {
    description: 'Landing to account created.',
  });
  assert.equal(steps[0].request.method, 'PATCH');
  assert.deepEqual(steps[4].request.body, { insight_id: 12 });
  assert.equal(
    steps[4].request.path,
    '/api/projects/1/dashboards/5/add_insight/',
  );
});

test('planBetterstack resolves monitors by name and heartbeats created in the same run', () => {
  const state = {
    heartbeats: [],
    monitors: [
      { id: '700', attributes: { pronounceable_name: 'acme.example.com' } },
    ],
    statusPages: [],
  };
  const steps = planBetterstack(example.betterstack, state);
  assert.deepEqual(
    steps.map((s) => `${s.action} ${s.type}`),
    [
      'create heartbeat',
      'create status page',
      'create resource',
      'create resource',
    ],
  );
  assert.equal(steps[1].request.body.resources, undefined);
  assert.deepEqual(steps[2].request.body, {
    public_name: 'Website',
    resource_type: 'Monitor',
    resource_id: '700',
  });
  assert.deepEqual(steps[3].request.body.resource_id, {
    $ref: 'betterstack-heartbeat:Acme nightly job',
  });
  assert.equal(
    steps[3].request.path,
    '/api/v2/status-pages/{{betterstack-page:acme-status-example}}/resources',
  );
});

test('planBetterstack skips a resource whose monitor does not exist', () => {
  const steps = planBetterstack(example.betterstack, {
    heartbeats: [],
    monitors: [],
    statusPages: [],
  });
  const website = steps.find((s) => s.name.endsWith('Website'));
  assert.equal(website.action, 'skip');
  assert.match(website.note, /no monitors named/);
});

test('resolveRefs fills paths and bodies, and refuses an unknown ref', () => {
  const ids = new Map([['a', 7]]);
  assert.equal(resolveRefs('/x/{{a}}/y', ids), '/x/7/y');
  assert.deepEqual(resolveRefs({ k: { $ref: 'a' }, l: [1] }, ids), {
    k: 7,
    l: [1],
  });
  assert.throws(() => resolveRefs({ $ref: 'b' }, ids), /no id recorded for b/);
});

test('sentryNext follows only a next link that has results', () => {
  const more =
    '<https://sentry.io/api/0/x/?cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1", <https://sentry.io/api/0/x/?cursor=0:100:0>; rel="next"; results="true"; cursor="0:100:0"';
  assert.equal(sentryNext(more), 'https://sentry.io/api/0/x/?cursor=0:100:0');
  assert.equal(
    sentryNext(more.replace('results="true"', 'results="false"')),
    null,
  );
  assert.equal(sentryNext(null), null);
});

test('makeClient errors name the status but never the token, and refuse other origins', async () => {
  const token = 'secret_token_value';
  const fetchImpl = async () =>
    new Response(`bad token ${token}`, { status: 401 });
  const client = makeClient({ host: 'https://sentry.io', token, fetchImpl });
  await assert.rejects(client.get('/api/0/x/'), (e) => {
    assert.match(
      e.message,
      /GET https:\/\/sentry.io\/api\/0\/x\/ answered 401/,
    );
    assert.ok(!e.message.includes(token));
    return true;
  });
  await assert.rejects(client.get('https://evil.example/api'), /refused/);
});

// ---------------------------------------------------------------------------------------------
// An in-memory stand-in for the three vendors, enough to run plan -> apply -> plan.

function fakeVendors() {
  const db = {
    sentry: [],
    phInsights: [],
    phDashboards: [],
    heartbeats: [],
    monitors: [
      {
        id: '700',
        type: 'monitor',
        attributes: { pronounceable_name: 'acme.example.com' },
      },
    ],
    pages: [],
    resources: {},
  };
  let next = 100;
  const calls = [];
  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), { status });
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const method = init.method;
    const body = init.body ? JSON.parse(init.body) : undefined;
    const auth = init.headers.Authorization;
    calls.push({ method, path: u.pathname, auth });
    const p = u.pathname;
    let m;
    // Sentry
    if (p === '/api/0/organizations/acme/dashboards/') {
      if (method === 'GET')
        return json(db.sentry.map((d) => ({ ...d, widgets: undefined })));
      const d = { ...body, id: String(next++) };
      d.widgets = d.widgets.map((w) => ({
        ...w,
        id: String(next++),
        dateCreated: 'now',
      }));
      db.sentry.push(d);
      return json(d, 201);
    }
    if ((m = p.match(/^\/api\/0\/organizations\/acme\/dashboards\/(\d+)\/$/))) {
      const d = db.sentry.find((x) => x.id === m[1]);
      if (method === 'PUT') Object.assign(d, body);
      return json(d);
    }
    // PostHog
    if (p === '/api/projects/1/insights/') {
      if (method === 'GET') {
        const s = u.searchParams.get('search');
        return json({
          next: null,
          results: db.phInsights.filter((i) => i.name.includes(s)),
        });
      }
      const i = { ...body, id: next++, query: { ...body.query, version: 2 } };
      db.phInsights.push(i);
      return json(i, 201);
    }
    if (p === '/api/projects/1/dashboards/') {
      if (method === 'GET')
        return json({ next: null, results: db.phDashboards });
      const d = { ...body, id: next++, tiles: [] };
      db.phDashboards.push(d);
      return json(d, 201);
    }
    if (
      (m = p.match(/^\/api\/projects\/1\/dashboards\/(\d+)\/(add_insight\/)?$/))
    ) {
      const d = db.phDashboards.find((x) => x.id === Number(m[1]));
      if (m[2]) d.tiles.push({ insight: { id: body.insight_id } });
      return json(d);
    }
    // Better Stack
    const list = (rows) => json({ data: rows, pagination: { next: null } });
    if (p === '/api/v2/heartbeats') {
      if (method === 'GET') return list(db.heartbeats);
      const h = { id: String(next++), type: 'heartbeat', attributes: body };
      db.heartbeats.push(h);
      return json({ data: h }, 201);
    }
    if (p === '/api/v2/monitors') return list(db.monitors);
    if (p === '/api/v2/status-pages') {
      if (method === 'GET') return list(db.pages);
      const pg = { id: String(next++), type: 'status_page', attributes: body };
      db.pages.push(pg);
      db.resources[pg.id] = [];
      return json({ data: pg }, 201);
    }
    if ((m = p.match(/^\/api\/v2\/status-pages\/(\d+)\/resources$/))) {
      if (method === 'GET') return list(db.resources[m[1]]);
      const r = {
        id: String(next++),
        attributes: { ...body, resource_id: Number(body.resource_id) },
      };
      db.resources[m[1]].push(r);
      return json({ data: r }, 201);
    }
    return json({ detail: 'not found' }, 404);
  };
  return { fetchImpl, calls, db };
}

test('a second run changes nothing, and no run ever deletes', async () => {
  const { fetchImpl, calls, db } = fakeVendors();
  const env = { ...TOKENS };
  const first = await plan(example, { env, apply: true, fetchImpl });
  assert.ok(
    first.steps.every((s) => s.action === 'create'),
    formatPlan(first.steps),
  );
  const log = [];
  await applyPlan(first.steps, first.clients, (l) => log.push(l));
  assert.equal(log.length, first.steps.length);
  assert.equal(db.phDashboards[0].tiles.length, 2);
  assert.equal(
    db.resources[db.pages[0].id][1].attributes.resource_id,
    Number(db.heartbeats[0].id),
  );

  const second = await plan(example, { env, apply: true, fetchImpl });
  assert.deepEqual(
    second.steps.filter((s) => s.action !== 'unchanged').map((s) => s.name),
    [],
    formatPlan(second.steps),
  );
  assert.ok(!calls.some((c) => c.method === 'DELETE'));
  for (const c of calls)
    assert.ok(Object.values(TOKENS).some((t) => c.auth === `Bearer ${t}`));
  assert.ok(!formatPlan(second.steps).includes('fake'));
});

test('a dry run skips a vendor whose token is missing; --apply refuses with the name only', async () => {
  const { fetchImpl, calls } = fakeVendors();
  const env = { FWD_POSTHOG_KEY: TOKENS.FWD_POSTHOG_KEY };
  const dry = await plan(example, { env, fetchImpl });
  assert.deepEqual(dry.notes, [
    'skipped   sentry: FWD_SENTRY_TOKEN is not set',
    'skipped   betterstack: FWD_BETTERSTACK_TOKEN is not set',
  ]);
  assert.ok(dry.steps.every((s) => s.vendor === 'posthog'));
  assert.ok(calls.every((c) => c.method === 'GET'));
  await assert.rejects(
    plan(example, { env, apply: true, fetchImpl }),
    /^Error: FWD_SENTRY_TOKEN is not set/,
  );
  const only = await plan(example, {
    env,
    apply: true,
    only: 'posthog',
    fetchImpl,
  });
  assert.deepEqual(only.notes, []);
});
