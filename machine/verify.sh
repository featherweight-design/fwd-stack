#!/usr/bin/env bash
# Checks that the fwd plugin is installed and enabled, and that the copy Claude Code runs answers as
# it should. Exit 0 only if every check passes.
set -uo pipefail
CFG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
LINK="$CFG/fwd"
fail=0
check() {
  if eval "$2" >/dev/null 2>&1; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi
}

PLUGIN=$(claude plugin list --json 2>/dev/null |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const p=JSON.parse(s).find(x=>x.id==="fwd@fwd-stack");if(p)process.stdout.write((p.enabled?"enabled":"disabled")+"\t"+p.installPath)}catch{}})')
STATE=${PLUGIN%%$'\t'*}
ROOT=${PLUGIN#*$'\t'}
check "plugin fwd@fwd-stack installed and enabled" '[ "$STATE" = enabled ]'
check "stable path points at the installed copy" '[ -n "$ROOT" ] && [ "$(cd "$LINK" && pwd -P)" = "$(cd "$ROOT" && pwd -P)" ]'
check "installed copy registers its hooks" 'grep -q "gate-hook.sh" "$ROOT/hooks/hooks.json" && grep -q "neon-prod-guard" "$ROOT/hooks/hooks.json" && grep -q "autonomous-guard" "$ROOT/hooks/hooks.json" && grep -q "secret-print-guard" "$ROOT/hooks/hooks.json" && grep -q "local-test-guard" "$ROOT/hooks/hooks.json"'
check "settings.json is valid JSON" '[ ! -f "$CFG/settings.json" ] || python3 -c "import json,sys;json.load(open(sys.argv[1]))" "$CFG/settings.json"'
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
check "no user-scope copies of the plugin's hooks remain" '[ ! -f "$CFG/settings.json" ] || python3 "$HERE/strip-hooks.py" --check "$CFG/settings.json"'
# Only a machine that had a ledger beside the old skill has one to carry.
LAST=$(cat "$CFG/backups/fwd-switchover-last" 2>/dev/null || true)
check "pre-open ledger carried over (when there was one)" '[ ! -f "$LAST/skills/pr-review/precheck-ledger.json" ] || [ -f "$CFG/plugins/data/fwd-fwd-stack/precheck-ledger.json" ]'

# Every guard check runs the INSTALLED copy, the one hooks.json runs through CLAUDE_PLUGIN_ROOT.
# The Neon guard denies a write to the first protected branch in fwd.json (or, with none, to a call
# that names no branch, which Neon runs on the default branch).
PROTECTED=$(node -e 'try{const c=require(process.argv[1]);process.stdout.write(Object.keys(c.neon?.protected??{})[0]??"")}catch{}' "$CFG/fwd.json" 2>/dev/null)
BRANCH_ARG=${PROTECTED:+\"branch_id\":\"$PROTECTED\",}
NEON_OUT=$(echo "{\"tool_name\":\"mcp__neon__run_sql\",\"tool_input\":{${BRANCH_ARG}\"sql\":\"delete from x\"}}" |
  CLAUDE_PROJECT_DIR= node "$ROOT/hooks/neon-prod-guard.mjs" 2>&1)
check "Neon guard denies a production write" 'grep -q "\"deny\"" <<<"$NEON_OUT"'

# The secret-print guard denies an environment dump.
SECRET_OUT=$(printf '%s' '{"tool_name":"Bash","tool_input":{"command":"printenv"}}' | node "$ROOT/hooks/secret-print-guard.mjs" 2>&1)
check "secret-print guard denies an environment dump" 'grep -q "\"deny\"" <<<"$SECRET_OUT"'

# The local-test guard denies a local test run.
TEST_OUT=$(printf '%s' '{"tool_name":"Bash","tool_input":{"command":"pnpm vitest run"}}' | node "$ROOT/hooks/local-test-guard.mjs" 2>&1)
check "local-test guard denies a local test run" 'grep -q "\"deny\"" <<<"$TEST_OUT"'

# The merge gate denies a command it cannot attribute (a fail-closed parse; no network needed).
GATE_OUT=$(printf '%s' '{"tool_input":{"command":"gh pr merge $PR --squash"}}' | bash "$ROOT/skills/pr-review/gate-hook.sh" 2>&1)
check "merge gate fails closed on an unreadable merge" 'grep -q "\"deny\"" <<<"$GATE_OUT"'
# The same gate reached through the stable path (a symlink) must not fail open either.
LINK_OUT=$(printf '%s' '{"tool_input":{"command":"gh pr merge $PR --squash"}}' | bash "$LINK/skills/pr-review/gate-hook.sh" 2>&1)
check "merge gate through the stable path fails closed too" 'grep -q "\"deny\"" <<<"$LINK_OUT"'

# The autonomous guard arms, blocks a stop, and disarms.
SID="verify-$$"
node "$ROOT/hooks/autonomous-guard.mjs" arm verify --session="$SID" --minutes=1 --max=1 >/dev/null 2>&1
STOP_OUT=$(echo "{\"session_id\":\"$SID\"}" | node "$ROOT/hooks/autonomous-guard.mjs" 2>&1)
node "$ROOT/hooks/autonomous-guard.mjs" disarm --session="$SID" >/dev/null 2>&1
check "autonomous guard blocks a stop while armed" 'grep -q "\"block\"" <<<"$STOP_OUT"'

exit $fail
