// node --test secret-guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  isSecretEnvFile,
  parseCommands,
  secretDecision,
} from './secret-guard.mjs';

// [command, pattern the reason must match]
const DENY = [
  // environment dumps
  ['env', /env.*no command/],
  ['/usr/bin/env', /env.*no command/],
  ['env | sort', /env.*no command/],
  ['env -0', /env.*no command/],
  ['env -u HOME', /env.*no command/],
  ['FOO=1 env', /env.*no command/],
  ['sudo env', /env.*no command/],
  ['sudo -E env', /env.*no command/],
  ['env | grep -i key', /env.*no command/],
  ['printenv', /printenv/],
  ['printenv DATABASE_URL', /printenv/],
  ['export -p', /export/],
  ['export', /export/],
  ['set', /bare `set`/],
  ['declare -x', /declare/],
  ['declare -p', /declare/],
  ['declare', /declare/],
  ['typeset -x', /typeset/],
  ['echo start; env; echo end', /env/],
  ['true && env', /env/],
  ['false || printenv', /printenv/],
  ['(env)', /env/],
  ['{ env; }', /env/],
  ['echo "$(env)"', /env/],
  ['echo `printenv`', /printenv/],
  ['x=$(env | wc -l)', /env/],
  ['diff <(env) /dev/null', /env/],
  ["bash -c 'env'", /env/],
  ['sh -c "printenv | head"', /printenv/],
  ['bash -lc env', /env/],
  ['eval env', /env/],
  ['nohup env', /env/],
  ['exec env', /env/],
  ['command env', /env/],
  ['time env', /env/],
  ['timeout 5 env', /env/],
  ['nice -n 5 printenv', /printenv/],
  ['echo x | xargs -I{} printenv', /printenv/],
  ["env -S 'printenv'", /printenv/],
  ['if true; then env; fi', /env/],
  ['bash <<EOF\nenv\nEOF', /env/],
  // .env files
  ['cat .env', /\.env file/],
  ['cat ./.env.local', /\.env file/],
  ['cat apps/web/.env.production', /\.env file/],
  ['cat .envrc', /\.env file/],
  ['cat .env*', /\.env file/],
  ['cat .env.local.backup', /\.env file/],
  ['head -n 5 .env', /\.env file/],
  ['tail -f .env', /\.env file/],
  ['less .env', /\.env file/],
  ['more .env', /\.env file/],
  ['bat .env', /\.env file/],
  ['grep KEY .env', /\.env file/],
  ['grep -A 3 KEY .env', /\.env file/],
  ['grep -e KEY .env', /\.env file/],
  ['rg DATABASE .env.local', /\.env file/],
  ["rg KEY -g '.env*'", /\.env file/],
  ['grep -r KEY --include=.env .', /\.env file/],
  ["sed -n '1,5p' .env", /\.env file/],
  ["awk -F= '{print $2}' .env", /\.env file/],
  ['strings .env', /\.env file/],
  ['xxd .env', /\.env file/],
  ['sort .env', /\.env file/],
  ['cat < .env', /\.env file/],
  ['while read l; do echo "$l"; done < .env', /\.env file/],
  ['sudo cat .env', /\.env file/],
  ['cat "$(pwd)/.env"', /\.env file/],
  ['cd app && cat .env', /\.env file/],
  ['cat .env | grep KEY', /\.env file/],
  ["bash -c 'cat .env'", /\.env file/],
  ['find . -name x | xargs cat .env', /\.env file/],
  // process listings
  ['pgrep -f next-server', /pgrep/],
  ['pgrep -fl node', /pgrep/],
  ['pgrep -lf node', /pgrep/],
  ['pgrep -a node', /pgrep/],
  ['pgrep -l node', /pgrep/],
  ['pgrep --full node', /pgrep/],
  ['pgrep -u me -f node', /pgrep/],
  ['ps aux', /ps/],
  ['ps axu', /ps/],
  ['ps auxww | grep node', /ps/],
  ['ps -ef', /ps/],
  ['ps -f', /ps/],
  ['ps eww 123', /ps/],
  ['ps -o pid,args', /ps/],
  ['ps -o pid=,command=', /ps/],
  ['ps -eo pid,cmd', /ps/],
  ['ps -p 123', /ps/],
  ['ps', /ps/],
  ['ps -E -o pid,comm', /ps/],
  ['ps -O pid', /ps/],
  ['cat /proc/1234/environ', /environment or command line/],
  ['cat /proc/self/environ', /environment or command line/],
  ["tr '\\0' '\\n' < /proc/1/environ", /environment or command line/],
  ['strings /proc/42/environ', /environment or command line/],
  ['cat /proc/42/cmdline', /environment or command line/],
  // inline code
  ["node -e 'console.log(process.env)'", /inline code/],
  ["node -e 'console.log(process.env.DATABASE_URL)'", /inline code/],
  ["node -p 'process.env.KEY'", /inline code/],
  ["node -pe 'process.env'", /inline code/],
  ["node --eval='console.log(process.env.KEY)'", /inline code/],
  ["node -e 'console.log(JSON.stringify(process.env))'", /inline code/],
  ['node -e \'console.log(process["env"].KEY)\'', /inline code/],
  ["node -e 'const {env} = process; console.log(env.KEY)'", /inline code/],
  [
    "node -e 'console.log(Boolean(process.env.KEY), process.env.KEY)'",
    /inline code/,
  ],
  ["node -e 'console.log(process.env.KEY.slice(0, 4))'", /inline code/],
  ["node -r dotenv/config -e 'console.log(process.env.KEY)'", /inline code/],
  [
    "node -e \"console.log(require('fs').readFileSync('.env','utf8'))\"",
    /\.env file/,
  ],
  ["bun -e 'console.log(Bun.env.KEY)'", /inline code/],
  ["bun --print 'process.env'", /inline code/],
  ["deno eval 'console.log(Deno.env.toObject())'", /inline code/],
  ['deno eval \'console.log(Deno.env.get("KEY"))\'', /inline code/],
  ["python3 -c 'import os; print(os.environ)'", /inline code/],
  ['python -c \'import os; print(os.environ["KEY"])\'', /inline code/],
  ['python3 -c \'import os; print(os.getenv("KEY"))\'', /inline code/],
  ["python3 -Bc 'from os import environ; print(environ)'", /inline code/],
  ['python3 -c "print(open(\'.env\').read())"', /\.env file/],
  ["ruby -e 'puts ENV.to_h'", /inline code/],
  ['perl -e \'print "$_=$ENV{$_}\\n" for keys %ENV\'', /inline code/],
  ["perl -le 'print $ENV{KEY}'", /inline code/],
  ['node <<EOF\nconsole.log(process.env.KEY)\nEOF', /inline code/],
  ["python3 - <<'PY'\nimport os\nprint(os.environ)\nPY", /inline code/],
  ["node <<< 'console.log(process.env)'", /inline code/],
  ['echo "$(node -e \'console.log(process.env.KEY)\')"', /inline code/],
  [
    'node -e \'require("fs").readFileSync("/proc/self/environ")\'',
    /environment or command line/,
  ],
];

const ALLOW = [
  // mentions in data, not commands
  'git commit -m "env: print nothing from printenv or cat .env"',
  'git commit -m "$(cat <<\'EOF\'\nfix: stop env dumps\n\nNo more `env`, printenv or cat .env (see ps aux).\nEOF\n)"',
  'echo env',
  "echo 'cat .env'",
  'echo "use pgrep -f carefully"',
  "printf '%s\\n' printenv",
  'grep -rn "process.env" src/',
  "grep -rn 'printenv' docs/",
  'grep -rn ".env" src/',
  "rg '\\.env' --type ts",
  'rg env src',
  'grep -A 3 .env src/config.ts',
  "sed -n '1,20p' src/env.ts",
  'cat src/env.ts',
  'cat env.d.ts',
  'cat config/environment.rb',
  'cat docs/env.md',
  'gh pr create --title "env guard" --body "blocks printenv and ps aux"',
  '# env\nls',
  // templates and metadata
  'cat .env.example',
  'cat .env.sample',
  'cat .env.template',
  'cat apps/web/.env.local.example',
  'ls -la .env*',
  'ls -la .env',
  'test -f .env && echo present',
  '[ -f .env.local ]',
  'stat .env',
  'wc -l .env',
  "grep -c '^KEY=' .env",
  "grep -q '^KEY=' .env && echo set",
  'rg -l KEY .env.local',
  'cp .env.example .env',
  'cat .env.example > .env',
  "cat > .env.local <<'EOF'\nKEY=placeholder\nEOF",
  'source .env && pnpm dev',
  '. ./.env',
  "sed -i '' 's/OLD/NEW/' .env",
  'git diff -- .env.example',
  'vercel env pull .env.local',
  'echo "KEY=x" >> .env',
  // env as a wrapper and other builtins
  'env NODE_ENV=test pnpm test',
  'env -i PATH=/usr/bin ls',
  '/usr/bin/env node script.js',
  'env -u DEBUG node app.js',
  'command -v env',
  'type printenv',
  'which env',
  'export FOO=bar',
  'export -n FOO',
  'set -euo pipefail',
  'set -x',
  'set -- a b',
  'declare -A map',
  'declare -f myfn',
  'declare -F',
  'declare -p PATH_PREFIX_LIST',
  'unset KEY',
  // processes
  'pgrep -x node',
  'pgrep node',
  'pgrep -u me node',
  'pkill -f next-server',
  'ps -o pid=,comm=',
  'ps -p 123 -o pid=,comm=',
  'ps -eo pid,ppid,comm,etime',
  'ps -A -o pid,comm',
  'ps axo pid,comm',
  'ps -o pid -o comm',
  'kill -0 123',
  'lsof -i :3000',
  'ls /proc/1',
  // inline code that tests presence or ignores the environment
  "node -e 'console.log(Boolean(process.env.KEY))'",
  'node -e "console.log(Boolean(process.env.DATABASE_URL))"',
  'node -e \'console.log(Boolean(process.env["KEY"]))\'',
  "node -e 'console.log(!!process.env.KEY)'",
  'node -e \'console.log("KEY" in process.env)\'',
  "node -e 'console.log(Boolean(process.env.A), Boolean(process.env.B))'",
  "node -e 'process.exit(Boolean(process.env.KEY) ? 0 : 1)'",
  "node -e 'console.log(1 + 1)'",
  'node -e \'console.log(require("./package.json").version)\'',
  "node -e \"console.log(require('fs').readFileSync('.env.example','utf8'))\"",
  'node script.js',
  'node scripts/check-env.mjs',
  'node --test plugins/fwd/hooks/secret-guard.test.mjs',
  "bun -e 'console.log(Boolean(Bun.env.KEY))'",
  'deno eval \'console.log(Deno.env.has("KEY"))\'',
  'deno eval \'console.log(Boolean(Deno.env.get("KEY")))\'',
  'python3 -c \'import os; print(bool(os.getenv("KEY")))\'',
  'python3 -c \'import os; print("KEY" in os.environ)\'',
  'python3 -c \'import os; print(bool(os.environ.get("KEY")))\'',
  "python3 -c 'print(1)'",
  'python3 -m http.server',
  'python3 manage.py check',
  'ruby -e \'puts ENV.key?("KEY")\'',
  "perl -e 'print exists $ENV{KEY} ? 1 : 0'",
  "node <<'EOF'\nconsole.log(1)\nEOF",
  // ordinary work
  'pnpm format:check && pnpm typecheck && pnpm lint',
  'git status',
  'ls -la',
  'gh pr view 1 --json state',
  'docker compose up -d',
  'echo $((1 + 2))',
  'cat package.json | jq .version',
  '',
];

for (const [cmd, pattern] of DENY)
  test(`denies: ${JSON.stringify(cmd)}`, () => {
    const reason = secretDecision(cmd);
    assert.ok(reason, 'expected a denial');
    assert.match(reason, pattern);
  });

for (const cmd of ALLOW)
  test(`allows: ${JSON.stringify(cmd)}`, () => {
    assert.equal(secretDecision(cmd), null);
  });

test('every denial names a safe alternative', () => {
  for (const [cmd] of DENY)
    assert.match(
      secretDecision(cmd),
      /pgrep -x|ps -o pid=,comm=|Boolean\(process\.env|ls -la \.env\*/,
      cmd,
    );
});

test('.env file names: templates are not secrets', () => {
  assert.equal(isSecretEnvFile('.env'), true);
  assert.equal(isSecretEnvFile('a/b/.env.production.local'), true);
  assert.equal(isSecretEnvFile('.env.example'), false);
  assert.equal(isSecretEnvFile('.env.sample'), false);
  assert.equal(isSecretEnvFile('.env.template'), false);
  assert.equal(isSecretEnvFile('env.ts'), false);
  assert.equal(isSecretEnvFile('.environment'), true);
});

test('the parser splits operators, keeps quoted text whole and skips heredoc bodies', () => {
  const words = (cmd) => parseCommands(cmd).map((s) => s.words);
  assert.deepEqual(words('a b | c && d; e & f || g'), [
    ['a', 'b'],
    ['c'],
    ['d'],
    ['e'],
    ['f'],
    ['g'],
  ]);
  assert.deepEqual(words('echo "a | b; c" \'d && e\''), [
    ['echo', 'a | b; c', 'd && e'],
  ]);
  assert.deepEqual(words('cat <<EOF\nenv\nEOF\nls'), [['cat'], ['ls']]);
  assert.deepEqual(words('ls 2>&1 >/dev/null'), [['ls']]);
});

// The hook itself: stdin payload in, deny JSON (or nothing) out.
const hook = fileURLToPath(
  new URL('./secret-print-guard.mjs', import.meta.url),
);
const run = (payload) =>
  execFileSync('node', [hook], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
  });

test('the hook denies a secret-printing Bash command', () => {
  const out = JSON.parse(
    run({ tool_name: 'Bash', tool_input: { command: 'printenv' } }),
  );
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(
    out.hookSpecificOutput.permissionDecisionReason,
    /^secret-print-guard: /,
  );
});

test('the hook stays silent on a safe command, another tool, or bad input', () => {
  assert.equal(
    run({ tool_name: 'Bash', tool_input: { command: 'git status' } }),
    '',
  );
  assert.equal(run({ tool_name: 'Read', tool_input: { command: 'env' } }), '');
  assert.equal(run({ tool_name: 'Bash', tool_input: {} }), '');
  assert.equal(run('{ not json'), '');
});
