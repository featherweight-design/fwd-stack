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
# The checkout's copy: the link's target comes from installed_plugins.json either way.
node "$HERE/../plugins/fwd/hooks/fwd-link.mjs" || echo "!! re-link failed; the next session start re-links."
LINK="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/fwd"
if [ -L "$LINK" ]; then
  echo "== $LINK -> $(readlink "$LINK")"
elif [ -e "$LINK" ]; then
  echo "!! $LINK exists and is not a symlink; move it aside and run machine/switch.sh."
else
  echo "!! $LINK is missing; run machine/switch.sh once."
fi
echo "== run /reload-plugins in each open session to load the new version there."
