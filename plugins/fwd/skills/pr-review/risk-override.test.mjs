// node --test risk-override.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HARD_RISKY,
  NOT_RISKY_TITLE,
  RISKY_PATH,
  modelRiskOf,
  hardRiskySignals,
  riskOverride,
} from './risk-override.mjs';

const body = (reason) =>
  `Summary.\n\n${NOT_RISKY_TITLE}\n\n${reason}\n\n## Claude review\n\ncavecrew-reviewer: no findings.\n`;
const displayOnly = [
  'src/lib/model/credit-line.ts',
  'src/lib/copy/credits.ts',
  'src/components/ui/credits-text.tsx',
];
const REASON =
  'Display and button gating only; the server-side charge is unchanged.';

test('the heading lanes write is the documented one', () => {
  assert.equal(NOT_RISKY_TITLE, '## Risk: not risky');
});

test('RISKY_PATH still reads the paths it always did', () => {
  for (const p of [
    'drizzle/0001_init.sql',
    'src/db/schema.ts',
    'src/db/index.ts',
    'src/lib/auth.ts',
    'src/middleware.ts',
    'src/proxy.ts',
    'src/lib/billing/charge.ts',
    'src/lib/credits.ts',
    'src/app/api/things/route.ts',
    'src/routes/things.ts',
    'src/lib/security/csp.ts',
    'src/lib/webhooks/handler.ts',
    ...displayOnly,
  ])
    assert.ok(RISKY_PATH.test(p), p);
  for (const p of [
    'src/components/ui/button.tsx',
    'src/lib/format.ts',
    'README.md',
  ])
    assert.ok(!RISKY_PATH.test(p), p);
});

test('design-token files are not risky; auth-token code and credential files stay risky', () => {
  for (const p of [
    'tokens/colors.css',
    'tokens/colors.scss',
    'tokens/colors.sass',
    'tokens/colors.less',
    'design/tokens/spacing.json',
    'src/styles/tokens.css',
    'src/theme/design-tokens.ts',
    'src/styles/color-tokens.js',
    'brand.tokens.json', // already passed before this change
  ])
    assert.ok(!RISKY_PATH.test(p), p);
  for (const p of [
    'lib/auth/token.ts',
    'src/server/refresh-token.ts',
    'api/tokens/route.ts',
    'utils/jwt-token.mjs',
    'middleware/csrf-token.ts',
    'src/server/tokens/colors.css',
    'src/auth/tokens/theme.json',
    'admin/tokens/keys.json',
    'config/tokens.json',
    'data/tokens/api-keys.json',
    'tokens/service-account.json',
    'src/lib/tokens.ts',
    'src/lib/token.ts',
    'lib/refresh_token.py',
    'refreshToken.ts',
    'brand.tokens.ts',
  ])
    assert.ok(RISKY_PATH.test(p), p);
});

test('modelRiskOf follows the same design-token rule', () => {
  assert.equal(modelRiskOf('tokens/colors.css'), null);
  assert.equal(modelRiskOf('lib/auth/token.ts'), 'auth');
  assert.equal(modelRiskOf('src/lib/refreshToken.ts'), 'security');
  assert.equal(modelRiskOf('config/tokens.json'), 'security');
});

test('cron routes and route handler files are risky paths', () => {
  for (const p of [
    'src/cron/nightly.ts',
    'src/app/cron/route.ts',
    'src/app/things/route.ts',
  ])
    assert.ok(RISKY_PATH.test(p), p);
});

test('every hard-risky pattern is also a risky path', () => {
  for (const p of [
    'migrations/0002.sql',
    'prisma/schema.prisma',
    'src/db/schema.ts',
    'src/app/api/x/route.ts',
    'src/cron/job.ts',
    'src/lib/session.ts',
    'src/middleware.ts',
    'src/lib/webhooks/stripe.ts',
  ]) {
    assert.ok(RISKY_PATH.test(p), p);
    assert.ok(
      HARD_RISKY.some(({ pattern }) => pattern.test(p)),
      `${p} is hard-risky`,
    );
  }
});

test('display-only credits paths carry no hard-risky signal', () => {
  assert.deepEqual(hardRiskySignals(displayOnly, false), []);
  assert.deepEqual(hardRiskySignals(displayOnly, true), ['destructive diff']);
});

test('a body with no declaration changes nothing', () => {
  const r = riskOverride('Summary.\n', {
    riskyPaths: displayOnly,
    destructive: false,
  });
  assert.equal(r.declared, false);
  assert.equal(r.applied, false);
  assert.equal(r.ignored, null);
  assert.equal(
    riskOverride(undefined, { riskyPaths: [], destructive: false }).declared,
    false,
  );
});

test('a real reason clears a path-risky PR with no hard-risky signal', () => {
  const r = riskOverride(body(REASON), {
    riskyPaths: displayOnly,
    destructive: false,
  });
  assert.equal(r.declared, true);
  assert.equal(r.applied, true);
  assert.equal(r.ignored, null);
  assert.equal(r.reason, REASON);
});

test('the reason may sit on the heading line itself', () => {
  const r = riskOverride(`${NOT_RISKY_TITLE} - display only, no write path\n`, {
    riskyPaths: displayOnly,
    destructive: false,
  });
  assert.equal(r.applied, true);
});

test('the heading is matched case-insensitively', () => {
  const r = riskOverride(`## risk: Not Risky\n\n${REASON}\n`, {
    riskyPaths: displayOnly,
    destructive: false,
  });
  assert.equal(r.applied, true);
});

for (const placeholder of [
  '',
  'TBD',
  'pending',
  'n/a',
  '<!-- why -->',
  'Reason: TBD',
  'Justification is pending.',
  'The reason for the override is TBD.',
  'Reason after review is pending.',
]) {
  test(`a placeholder reason ${JSON.stringify(placeholder)} does not count`, () => {
    const r = riskOverride(body(placeholder), {
      riskyPaths: displayOnly,
      destructive: false,
    });
    assert.equal(r.declared, true);
    assert.equal(r.applied, false);
    assert.match(r.ignored, /placeholder/);
  });
}

test('a reason whose prose ends on a placeholder word counts', () => {
  const r = riskOverride(
    body('Display only: it shows a badge while the order is pending.'),
    { riskyPaths: displayOnly, destructive: false },
  );
  assert.equal(r.applied, true);
});

test('the reason stops at the next heading', () => {
  const r = riskOverride(
    `${NOT_RISKY_TITLE}\n\n## Claude review\n\ncavecrew-reviewer: no findings.\n`,
    {
      riskyPaths: displayOnly,
      destructive: false,
    },
  );
  assert.equal(r.applied, false);
});

test('a destructive diff ignores the declaration', () => {
  const r = riskOverride(body(REASON), {
    riskyPaths: displayOnly,
    destructive: true,
  });
  assert.equal(r.applied, false);
  assert.deepEqual(r.signals, ['destructive diff']);
  assert.match(r.ignored, /hard-risky signal \(destructive diff\)/);
});

for (const [path, name] of [
  ['drizzle/0003_add.sql', 'migration/schema'],
  ['src/db/schema.ts', 'migration/schema'],
  ['prisma/schema.prisma', 'migration/schema'],
  ['src/app/api/credits/route.ts', 'API/cron route'],
  ['src/cron/expire-credits.ts', 'API/cron route'],
  ['src/lib/auth.ts', 'auth/session/middleware/proxy'],
  ['src/lib/session.ts', 'auth/session/middleware/proxy'],
  ['src/middleware.ts', 'auth/session/middleware/proxy'],
  ['src/proxy.ts', 'auth/session/middleware/proxy'],
  ['src/lib/webhooks/payments.ts', 'webhook'],
]) {
  test(`a ${name} path (${path}) ignores the declaration`, () => {
    const r = riskOverride(body(REASON), {
      riskyPaths: [...displayOnly, path],
      destructive: false,
    });
    assert.equal(r.applied, false);
    assert.deepEqual(r.signals, [`${name}: ${path}`]);
    assert.match(r.ignored, new RegExp(`hard-risky signal \\(${name}: `));
  });
}

test('a declaration on a PR the paths already call safe is reported as not needed', () => {
  const r = riskOverride(body(REASON), { riskyPaths: [], destructive: false });
  assert.equal(r.declared, true);
  assert.equal(r.applied, false);
  assert.match(r.ignored, /not needed/);
});

test('modelRiskOf names one category per path and ignores docs, tests and API routes', () => {
  assert.equal(modelRiskOf('src/lib/billing/charge.ts'), 'money');
  assert.equal(modelRiskOf('src/lib/auth.ts'), 'auth');
  assert.equal(modelRiskOf('drizzle/0001_init.sql'), 'migrations');
  assert.equal(modelRiskOf('src/lib/crypto/keys.ts'), 'security');
  assert.equal(modelRiskOf('docs/auth.md'), null);
  assert.equal(modelRiskOf('src/lib/billing/charge.test.ts'), null);
  assert.equal(modelRiskOf('src/app/api/things/route.ts'), null);
});
