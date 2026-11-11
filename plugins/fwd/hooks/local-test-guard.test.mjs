// node --test local-test-guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { localTestDecision } from './local-test-guard.mjs';

// [command, pattern the reason must match]
const DENY = [
  // the three commands that slowed the machine
  [
    'pnpm turbo typecheck lint --filter web && npx vitest run src/x | grep -v foo',
    /`vitest` runs tests/,
  ],
  [
    'pnpm turbo build --filter web; pnpm typecheck; pnpm vitest run',
    /`turbo build`/,
  ],
  ['pnpm --filter web exec vitest run test', /`vitest` runs tests/],
  // test runners
  ['vitest', /vitest/],
  ['vitest run', /vitest/],
  ['./node_modules/.bin/vitest run', /vitest/],
  ['jest --watch', /jest/],
  ['playwright test', /playwright test/],
  ['npx playwright test e2e/', /playwright test/],
  ['mocha', /mocha/],
  ['node --test', /node --test/],
  ['node --test tests/*.test.mjs', /node --test/],
  ['node --test-reporter=spec --test x.mjs', /node --test/],
  ['tsx --test src', /tsx --test/],
  ['bun test', /bun test/],
  ['pytest -q', /pytest/],
  ['python3 -m pytest tests', /pytest/],
  ['python -W ignore -m pytest', /pytest/],
  ['node -r dotenv/config --test', /node --test/],
  ['node --import tsx --test src', /node --test/],
  ['node --test-reporter spec --test', /node --test/],
  ['node --run test', /node --run test/],
  ['node --run=build', /node --run build/],
  ['yarn run vitest', /vitest/],
  ['bun run jest', /jest/],
  ['npx -c "vitest run"', /vitest/],
  ['pnpm exec -c "vitest run"', /vitest/],
  ['npm it', /npm it/],
  ['npm cit', /npm cit/],
  ['yarn workspaces foreach --include web run build', /yarn run build/],
  ['cargo --locked test', /cargo test/],
  ['go -C apps/api test ./...', /go test/],
  ['go test ./...', /go test/],
  ['cargo test', /cargo test/],
  ['cargo +nightly test', /cargo test/],
  ['deno test', /deno test/],
  // package scripts
  ['pnpm test', /pnpm test/],
  ['pnpm t', /pnpm t/],
  ['pnpm run test', /pnpm run test/],
  ['pnpm test:unit', /test:unit/],
  ['pnpm run test:e2e --filter web', /test:e2e/],
  ['pnpm -r test', /pnpm test/],
  ['pnpm --filter web test', /pnpm test/],
  ['pnpm -F web test', /pnpm test/],
  ['pnpm -C apps/web test', /pnpm test/],
  ['npm test', /npm test/],
  ['npm run test', /npm run test/],
  ['npm -w web test', /npm test/],
  ['npm test --workspace web', /npm test/],
  ['yarn test', /yarn test/],
  ['yarn run test', /yarn run test/],
  ['yarn workspace web test', /yarn test/],
  ['yarn workspaces foreach -A run test', /yarn run test/],
  ['bun run test', /bun run test/],
  ['pnpm exec vitest', /vitest/],
  ['pnpm exec -- vitest run', /vitest/],
  ['pnpm dlx vitest', /vitest/],
  ['npm exec -- jest', /jest/],
  ['npx vitest run', /vitest/],
  ['npx --yes vitest', /vitest/],
  ['bunx vitest', /vitest/],
  ['pnpm vitest run', /vitest/],
  ['pnpm --filter web vitest', /vitest/],
  ['pnpm dotenv -e ../../.env -- vitest run', /vitest/],
  ['cross-env NODE_ENV=test jest', /jest/],
  // production builds
  ['turbo build', /turbo build/],
  ['turbo run build', /turbo build/],
  ['turbo run test', /turbo test/],
  ['turbo test:unit --filter web', /turbo test:unit/],
  ['turbo run web#build', /turbo web#build/],
  ['pnpm turbo build', /turbo build/],
  ['pnpm turbo run build --filter=web', /turbo build/],
  ['next build', /next build/],
  ['pnpm next build', /next build/],
  ['vite build', /vite build/],
  ['pnpm build', /pnpm build/],
  ['pnpm run build', /pnpm run build/],
  ['pnpm build:packages', /build:packages/],
  ['npm run build', /npm run build/],
  ['yarn run build', /yarn run build/],
  ['yarn build', /yarn build/],
  // nesting and wrappers
  ['echo start; pnpm test', /pnpm test/],
  ['false || pnpm test', /pnpm test/],
  ['pnpm lint\npnpm test', /pnpm test/],
  ['x=$(pnpm test)', /pnpm test/],
  ['echo `vitest run`', /vitest/],
  ['(cd apps/web && pnpm test)', /pnpm test/],
  ["bash -c 'pnpm test'", /pnpm test/],
  ['sh -c "cd web && vitest run"', /vitest/],
  ['eval pnpm test', /pnpm test/],
  ['timeout 600 pnpm test', /pnpm test/],
  ['CI=1 pnpm test', /pnpm test/],
  ['env CI=1 vitest run', /vitest/],
  ['nohup pnpm build', /pnpm build/],
  ['ls src | xargs vitest run', /vitest/],
  ['watch pnpm test', /pnpm test/],
  ['bash <<EOF\npnpm test\nEOF', /pnpm test/],
];

const ALLOW = [
  'pnpm typecheck',
  'pnpm lint',
  'pnpm format:check && pnpm typecheck && pnpm lint',
  'pnpm turbo typecheck lint --filter web',
  'turbo typecheck lint',
  'turbo run lint',
  'pnpm -r typecheck',
  'pnpm --filter web lint',
  'tsc --noEmit',
  'pnpm exec tsc --noEmit -p apps/web',
  'npx tsc',
  'eslint .',
  'npx eslint src',
  'gh run watch 123',
  'gh run view 123 --log-failed',
  'gh pr checks 61',
  'grep -rn vitest src',
  'rg "pnpm test" docs',
  'echo "run tests"',
  "echo 'pnpm build'",
  'git commit -m "test: cover the guard"',
  'git commit -m "build: bump turbo"',
  'cat src/foo.test.ts',
  'sed -n 1,40p apps/web/vitest.config.ts',
  'ls tests',
  'test -f package.json && echo ok',
  '[ -d node_modules ]',
  'pnpm install',
  'pnpm add -D vitest',
  'pnpm why jest',
  'vitest --version',
  'jest --help',
  'playwright install chromium',
  'node --check plugins/fwd/hooks/local-test-guard.mjs',
  'node scripts/run.mjs --test',
  'go build ./...',
  'go vet ./...',
  'cargo check',
  'next dev',
  'vite',
  'turbo prune web',
  'turbo prune web --out-dir build',
  'turbo run lint --cache-dir build',
  'python manage.py -m pytest',
  'python -c "import pytest"',
  'node --run lint',
  'yarn run lint',
  'npx -c "tsc --noEmit"',
  'cargo --locked build',
  'npm ci',
  'command -v vitest',
  'which jest',
  '',
];

test('denies a test run or production build in any segment', () => {
  for (const [command, pattern] of DENY) {
    const reason = localTestDecision(command);
    assert.ok(reason, `expected a denial: ${JSON.stringify(command)}`);
    assert.match(reason, pattern, JSON.stringify(command));
    assert.match(reason, /typecheck and lint only/);
    assert.match(reason, /pr-review §5/);
  }
});

test('allows typecheck, lint, CI lookups and commands that only mention a word', () => {
  for (const command of ALLOW)
    assert.equal(
      localTestDecision(command),
      null,
      `expected allow: ${JSON.stringify(command)}`,
    );
});

test('a non-string command is allowed', () => {
  assert.equal(localTestDecision(undefined), null);
  assert.equal(localTestDecision(42), null);
});

// The hook itself: stdin payload in, deny JSON (or nothing) out.
const hook = fileURLToPath(new URL('./local-test-guard.mjs', import.meta.url));
const run = (payload) =>
  execFileSync('node', [hook], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
  });

test('the hook denies a local test run', () => {
  const out = JSON.parse(
    run({ tool_name: 'Bash', tool_input: { command: 'pnpm vitest run' } }),
  );
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(
    out.hookSpecificOutput.permissionDecisionReason,
    /^local-test-guard: /,
  );
});

test('the hook stays silent on typecheck, another tool, or bad input', () => {
  assert.equal(
    run({ tool_name: 'Bash', tool_input: { command: 'pnpm typecheck' } }),
    '',
  );
  assert.equal(
    run({ tool_name: 'Read', tool_input: { command: 'pnpm test' } }),
    '',
  );
  assert.equal(run({ tool_name: 'Bash', tool_input: {} }), '');
  assert.equal(run('{ not json'), '');
  assert.equal(run('null'), '');
});
