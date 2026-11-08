#!/usr/bin/env bash
# Install the fwd plugin on this machine, and retire any user-scope copies of its skills and hooks.
# A one-time setup: works on a fresh machine (nothing to retire) and on one that ran the skills from
# ~/.claude/skills. Re-running it on a switched machine is harmless, but an update does not need it:
# use machine/update.sh or marketplace auto-update, then /reload-plugins (README, "Updating").
#
#   machine/switch.sh --dry-run   print every step, change nothing
#   machine/switch.sh             back up, apply, verify; any failure after the backup rolls back
#
# Run it when no session is mid-review or mid-merge: a running session can drop its user-scope hooks
# when settings.json changes, but loads the plugin's only when it restarts. Restart sessions after.
# -E: the ERR trap below also fires for a failure inside `run`, not only at the top level.
set -Eeuo pipefail

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1
CFG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP="$CFG/backups/fwd-switchover-$STAMP"
DATA="$CFG/plugins/data/fwd-fwd-stack"
LINK="$CFG/fwd" # stable path for Bash commands and docs: <config>/fwd/skills/..., <config>/fwd/hooks/...
# Every skill the plugin ships, read from this checkout, so a new skill is retired too.
FWD_SKILLS=()
for d in "$HERE/../plugins/fwd/skills"/*/; do FWD_SKILLS+=("$(basename "$d")"); done
# CLAUDE.md is edited where it really lives, so a dotfiles symlink stays a symlink.
# The whole chain is resolved (a link to a link), so no intermediate link is replaced by a file.
CLAUDE_MD="$CFG/CLAUDE.md"
[ -L "$CLAUDE_MD" ] && CLAUDE_MD="$(python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$CLAUDE_MD")"
# How CLAUDE.md names the config folder: `~/.claude` by default, else its absolute path.
if [ "$CFG" = "$HOME/.claude" ]; then SHOWN='~/.claude'; else SHOWN="$CFG"; fi

run() {
  echo "+ $*"
  [ $DRY -eq 1 ] || eval "$@"
}
# The installed copy's path, empty when not installed. Exits non-zero when the listing itself cannot
# be read: "unknown" must never be taken for "not installed", or a rollback would uninstall a plugin
# that was there before.
installed_path() {
  local out
  out=$(claude plugin list --json 2>/dev/null) || return 1
  node -e 'const p=JSON.parse(process.argv[1]).find(x=>x.id==="fwd@fwd-stack");process.stdout.write(p?p.installPath:"")' "$out"
}

echo "== fwd switchover ($([ $DRY -eq 1 ] && echo DRY RUN || echo APPLY)), backup: $BACKUP"

# Snapshot settings.json before the first `claude` command: the CLI rewrites it on any run
# (normalising keys), so a copy taken later would not be what the user had.
# A settings.json that exists but is not a readable regular file (a dangling or odd symlink) is the
# user's to sort out first: the cleanup below would otherwise take it for absent and remove it.
if { [ -e "$CFG/settings.json" ] || [ -L "$CFG/settings.json" ]; } && [ ! -f "$CFG/settings.json" ]; then
  echo "$CFG/settings.json is not a regular file (a dangling symlink?); fix it first. Nothing changed."
  exit 1
fi
PRE_SETTINGS=""
SETTINGS_EXISTED=0
if [ -f "$CFG/settings.json" ]; then
  SETTINGS_EXISTED=1
  PRE_SETTINGS=$(mktemp)
  cp -p "$CFG/settings.json" "$PRE_SETTINGS"
fi
# Until the backup is complete, any exit (a failed precondition, a dry run) puts settings.json back
# as it was: the user's bytes, or no file at all.
COMMITTED=0
put_settings_back() {
  [ $COMMITTED -eq 1 ] && return
  if [ -n "$PRE_SETTINGS" ]; then cp -p "$PRE_SETTINGS" "$CFG/settings.json"; else rm -f "$CFG/settings.json"; fi
}
trap put_settings_back EXIT

# 0. Preconditions, checked before anything changes.
if [ -e "$LINK" ] && [ ! -L "$LINK" ]; then
  echo "$LINK exists and is not a symlink; move it aside first. Nothing changed."
  exit 1
fi
# Every existing ledger must parse before anything changes: a merge must never treat a malformed one
# as empty and replace it.
for L in "$CFG/skills/pr-review/precheck-ledger.json" "$DATA/precheck-ledger.json"; do
  if [ -f "$L" ] && ! node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(!Array.isArray(d?.entries))process.exit(1)' "$L" 2>/dev/null; then
    echo "$L is not a readable ledger; fix or move it first. Nothing changed."
    exit 1
  fi
done
if ! PREV_PATH=$(installed_path); then
  echo "could not read 'claude plugin list --json'; not changing anything without knowing what is installed."
  exit 1
fi

# 1. Back up everything this touches, and record what was there before, so a rollback restores it.
run "mkdir -p '$BACKUP/skills'"
[ -n "$PRE_SETTINGS" ] && run "cp -p '$PRE_SETTINGS' '$BACKUP/settings.json'"
[ -f "$CLAUDE_MD" ] && run "cp -p '$CLAUDE_MD' '$BACKUP/CLAUDE.md'"
for s in "${FWD_SKILLS[@]}"; do
  # -L too: a skill that is a symlink (dangling or not) is still a copy to back up and retire.
  { [ -e "$CFG/skills/$s" ] || [ -L "$CFG/skills/$s" ]; } && run "cp -Rp '$CFG/skills/$s' '$BACKUP/skills/$s'"
done
# Contents, not the folder: when hooks/ or lib/ is a symlinked directory, copying the link would
# leave a backup that points at the very files step 6 deletes.
for d in hooks lib; do
  [ -d "$CFG/$d" ] && run "mkdir -p '$BACKUP/$d' && cp -Rp '$CFG/$d/.' '$BACKUP/$d/'"
done
WAS_INSTALLED=$([ -n "$PREV_PATH" ] && echo 1 || echo 0)
WAS_LINK=$([ -L "$LINK" ] && readlink "$LINK" || echo "")
# An existing install is backed up whole (its cached copy and the install record), so a failed
# update can be put back exactly; Claude Code has no command to install an older version.
if [ "$WAS_INSTALLED" = 1 ]; then
  run "cp -Rp '$PREV_PATH' '$BACKUP/plugin-copy'"
  run "cp -p '$CFG/plugins/installed_plugins.json' '$BACKUP/installed_plugins.json'"
fi
if [ $DRY -eq 0 ]; then
  # Written last: rollback.sh refuses a backup without it, so an interrupted backup is never used.
  LEDGER_EXISTED=$([ -f "$DATA/precheck-ledger.json" ] && echo 1 || echo 0)
  printf 'WAS_INSTALLED=%s\nWAS_LINK=%q\nCLAUDE_MD=%q\nPREV_PATH=%q\nLEDGER_EXISTED=%s\nSETTINGS_EXISTED=%s\n' \
    "$WAS_INSTALLED" "$WAS_LINK" "$CLAUDE_MD" "$PREV_PATH" "$LEDGER_EXISTED" "$SETTINGS_EXISTED" >"$BACKUP/state"
  echo "$BACKUP" >"$CFG/backups/fwd-switchover-last"
  # From here, any failure rolls back to this backup.
  trap 'echo "!! step failed: rolling back from $BACKUP"; "$HERE/rollback.sh" "$BACKUP"; exit 1' ERR
  # An interruption (Ctrl-C, a closed terminal) rolls back too, rather than leaving half a switch.
  trap 'trap - ERR INT TERM HUP; echo "!! interrupted: rolling back from $BACKUP"; "$HERE/rollback.sh" "$BACKUP"; exit 130' INT TERM HUP
  # Only now, with the backup complete and every rollback trap armed, does rollback (not the EXIT
  # trap) take over restoring settings.json.
  COMMITTED=1
fi

# 2. Install the plugin from its GitHub marketplace, or bring an existing install up to date.
if ! claude plugin marketplace list 2>/dev/null | grep -q 'fwd-stack'; then
  run "claude plugin marketplace add featherweight-design/fwd-stack"
else
  run "claude plugin marketplace update fwd-stack"
fi
if [ "$WAS_INSTALLED" = 1 ]; then
  run "claude plugin update fwd@fwd-stack --scope user"
else
  run "claude plugin install fwd@fwd-stack --scope user"
fi
# Enabled is a setting, not part of the install: a machine that disabled it, or lost settings.json,
# would otherwise end with the plugin installed and silent.
run "claude plugin enable fwd@fwd-stack --scope user >/dev/null 2>&1 || true"
# Confirmed for fwd@fwd-stack itself before anything is retired; a failure rolls back here.
[ $DRY -eq 1 ] || claude plugin list --json 2>/dev/null |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.exit(JSON.parse(s).some(x=>x.id==="fwd@fwd-stack"&&x.enabled)?0:1))'

# 3. Carry state into the plugin's data folder: the pre-open pass ledger.
run "mkdir -p '$DATA'"
if [ -f "$CFG/skills/pr-review/precheck-ledger.json" ]; then
  if [ -f "$DATA/precheck-ledger.json" ]; then
    # Both exist (Bash runs of the plugin's scripts already wrote the data one): merge, so no legacy
    # row drops out of the ledger the plugin reads. The data one is newer and wins on a shared row.
    run "cp -p '$DATA/precheck-ledger.json' '$BACKUP/ledger-data-before.json'"
    run "cp -p '$CFG/skills/pr-review/precheck-ledger.json' '$DATA/precheck-ledger.json.legacy'"
    run "node '$HERE/merge-ledgers.mjs' '$DATA/precheck-ledger.json.legacy' '$DATA/precheck-ledger.json' && mv '$DATA/precheck-ledger.json.legacy' '$DATA/precheck-ledger.json'"
  else
    run "cp -p '$CFG/skills/pr-review/precheck-ledger.json' '$DATA/precheck-ledger.json'"
  fi
fi

# 4. Stable path to the copy Claude Code actually runs (the install cache), for commands outside hooks.
if [ $DRY -eq 1 ]; then
  echo "+ ln -sfn <installed plugin path> '$LINK'"
else
  INSTALLED="$(installed_path)"
  [ -n "$INSTALLED" ] || { echo "plugin not reported as installed"; false; }
  run "ln -sfn '$INSTALLED' '$LINK'"
fi

# 5. Remove the user-scope hook entries the plugin now provides (gate, Neon guard, autonomous guard).
[ -f "$CFG/settings.json" ] && run "python3 '$HERE/strip-hooks.py' '$CFG/settings.json'"

# 6. Retire the duplicate user-scope skills (the plugin ships them), and the old hook copies.
for s in "${FWD_SKILLS[@]}"; do
  { [ -e "$CFG/skills/$s" ] || [ -L "$CFG/skills/$s" ]; } && run "rm -rf '$CFG/skills/$s'"
done
for f in autonomous-guard.mjs neon-guard.mjs neon-prod-guard.mjs session-budget.mjs; do
  [ -e "$CFG/hooks/$f" ] && run "rm -f '$CFG/hooks/$f'"
done
[ -e "$CFG/lib/fwd-config.mjs" ] && run "rm -f '$CFG/lib/fwd-config.mjs'"

# 7. Point the user CLAUDE.md at the stable path.
# Both spellings of the old paths, `~/.claude/...` and the config folder's absolute path, are rewritten.
for OLD in '~/.claude' "$CFG"; do
  [ -f "$CLAUDE_MD" ] && run "perl -pi -e 's#\\Q$OLD\\E/skills/pr-review/#$SHOWN/fwd/skills/pr-review/#g; s#\\Q$OLD\\E/hooks/autonomous-guard\\.mjs#$SHOWN/fwd/hooks/autonomous-guard.mjs#g' '$CLAUDE_MD'"
done

if [ $DRY -eq 1 ]; then
  # The EXIT trap puts settings.json back: the `claude` commands above rewrite it on any run.
  echo "== dry run complete: nothing changed"
  exit 0
fi

# 8. Verify; roll back on any failure. (An interruption here still rolls back.)
trap - ERR
if ! "$HERE/verify.sh"; then
  echo "!! verification failed: rolling back from $BACKUP"
  "$HERE/rollback.sh" "$BACKUP"
  exit 1
fi
echo "== switchover complete. Restart Claude sessions to load the plugin's hooks."
