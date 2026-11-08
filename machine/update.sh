#!/usr/bin/env bash
# Bring the fwd plugin up to date on a machine where machine/switch.sh has already run.
#
#   machine/update.sh
#
# Safe while sessions run: a running session keeps the version it loaded until you run
# /reload-plugins in it (or start a new one). The plugin's own hook (hooks/fwd-link.mjs) re-points
# ~/.claude/fwd at the installed version at the next session start or prompt; this runs it now too.
# With marketplace auto-update on (README, "Updating"), Claude Code does the first two steps itself.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

claude plugin marketplace update fwd-stack
claude plugin update fwd@fwd-stack --scope user
node "$HERE/../plugins/fwd/hooks/fwd-link.mjs"
echo "== fwd is $(readlink "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/fwd" 2>/dev/null || echo 'not linked: run machine/switch.sh')"
echo "== run /reload-plugins in each open session to load the new version there."
