#!/usr/bin/env bash
# PreToolUse guard: run the pr-review gate before a merge or a re-request.
#
# The rules were prose in a skill, and the author of that skill broke three of
# them in one PR — not from disagreement, but from not knowing in the moment
# what round it was. This makes the harness ask instead of the model remember.
#
# Denies the tool call when pr-gate.mjs exits non-zero, and puts the gate's own
# reasoning in the denial so the next step is obvious rather than a mystery.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
payload=$(cat)
cmd=$(printf '%s' "$payload" | jq -r '.tool_input.command // ""')
# The session's working directory, where a relative `cd` in the command starts from.
session_cwd=$(printf '%s' "$payload" | jq -r '.cwd // ""')
[ -z "$session_cwd" ] && session_cwd=$PWD

# Which gated actions the command takes, on which PRs and repositories, one line per gated
# command: a chain such as `gh pr merge feat/x; gh pr merge 42` is checked in full. The parsing
# lives in parse-command.mjs, where it is tested.
#
# The repository matters too. The hook runs in the SESSION's working directory, which is not
# always the checkout the command `cd`s into, so each command's own `repos/O/R/`, `-R`, `--repo`,
# `GH_REPO=` or pull URL wins, and the session's directory is never consulted for it. A command
# that names none is resolved by `gh repo view` in the directory it really runs in: the parser
# prints `cd <dir>` when the line reaches it by plain `cd` steps, and `cd?` when it changes
# directory in a way it cannot follow. Outside any checkout with no repository named, the gate
# cannot resolve one and the command is denied, as before.
# If the parser itself fails (node missing, a throw), deny: an empty answer would read as
# "nothing gated" and let the merge through.
if ! gated=$(node "$here/parse-command.mjs" "$cmd" "$session_cwd"); then
  jq -nc '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny",
    permissionDecisionReason: "pr-review gate: the command parser failed, so the merge bar cannot be checked. Fix the hook (is node on PATH?) before merging."}}'
  exit 0
fi

# Nothing gated, or no PR number to check (e.g. `gh pr merge` on the current branch): allow
# rather than guess. A gate that blocks what it cannot read teaches people to disable it.
[ -z "$gated" ] && exit 0

# A merge the parser could not attribute to a PR is denied, never allowed: see parse-command.mjs.
if printf '%s\n' "$gated" | grep -qx 'unreadable'; then
  jq -nc '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: ("pr-review gate: this command mentions a merge or a review re-request the gate cannot attribute to a PR and repository, so it cannot check the bar. Run the merge as its own plain command, `gh pr merge <number> [--repo owner/name] [flags]` or `gh api -X PUT repos/<owner>/<name>/pulls/<number>/merge`, with no wrapper, substitution or heredoc around it. A merge of the current branch must name its number. If the text only MENTIONS a merge (a heredoc, a message), rephrase it.")
    }
  }'
  exit 0
fi

# The away-window flags (`--auto`, `--admin`, a queue or API merge form) come from the parser on
# their own `flags <csv>` line. They are taken OUT of the list before the loop below, so that line
# can never be read as an action, and they go to the gate as `--merge-flags`: the gate is the one
# place that decides whether the window forbids them.
flags=$(printf '%s\n' "$gated" | sed -n 's/^flags //p' | paste -sd, -)
gated=$(printf '%s\n' "$gated" | grep -v '^flags ' || true)
extra=()
[ -n "$flags" ] && extra=(--merge-flags "$flags")

# Run the NEWEST installed gate, resolved now rather than when the session loaded its hooks, so a
# gate fix reaches a running session without /reload-plugins. gate-path.mjs only trusts
# ~/.claude/fwd when it resolves into the fwd plugin cache; otherwise, or if it fails, the gate
# bundled beside this script runs. Either way a gate runs, and a gate that crashes or cannot load
# exits non-zero, which denies below: this never fails open. Resolved only once a command is
# gated, so ungated calls pay nothing.
bundled="$here/pr-gate.mjs"
gate=$(node "$here/gate-path.mjs" "$bundled" 2>/dev/null) || gate="$bundled"
[ -n "$gate" ] && [ -f "$gate" ] || gate="$bundled"
# An installed gate from before the away rule ignores --merge-flags. For a flagged line the
# resolved gate must name that flag in its source, or the gate bundled beside this script judges.
if [ -n "$flags" ] && ! grep -qF -- '--merge-flags' "$gate" 2>/dev/null; then
  gate="$bundled"
fi

# Where the gated commands run: `cd <dir>`, `cd?` (unknown), or neither (the session's directory).
run_dir=""
dir_unknown=0
printf '%s\n' "$gated" | grep -x 'cd?' >/dev/null && dir_unknown=1
run_dir=$(printf '%s\n' "$gated" | sed -n 's/^cd //p' | head -n 1)

out=""
ran=""
status=0
while read -r action pr repo; do
  [ -z "${pr:-}" ] && continue
  case "$action" in merge | rerequest) ;; *) continue ;; esac
  ran=""
  if [ -n "${repo:-}" ]; then
    # The command names its repository, so that decides, wherever the command runs. The gate
    # still starts in the command's own directory when it exists, for its push-landed check.
    if [ -n "$run_dir" ] && [ -d "$run_dir" ]; then
      ran=$gate
      out=$(cd "$run_dir" && node "$gate" "$pr" --action "$action" --repo "$repo" ${extra[@]+"${extra[@]}"} 2>&1)
    else
      ran=$gate
      out=$(node "$gate" "$pr" --action "$action" --repo "$repo" ${extra[@]+"${extra[@]}"} 2>&1)
    fi
  elif [ $dir_unknown -eq 1 ]; then
    out="this command changes directory in a way the gate cannot follow (a cd with no path, cd -, an option or redirection on the cd, pushd or popd, or a cd sharing a subshell or pipeline with the $action), so it cannot tell which repository PR #$pr is in. Name it in the command: --repo owner/name, or repos/<owner>/<name>/pulls/$pr in an API path."
    false
  elif [ -n "$run_dir" ]; then
    if [ -d "$run_dir" ]; then
      ran=$gate
      out=$(cd "$run_dir" && node "$gate" "$pr" --action "$action" ${extra[@]+"${extra[@]}"} 2>&1)
    else
      out="the command runs in $run_dir, which does not exist, so the gate cannot tell which repository PR #$pr is in. Name it in the command: --repo owner/name."
      false
    fi
  else
    ran=$gate
    out=$(node "$gate" "$pr" --action "$action" ${extra[@]+"${extra[@]}"} 2>&1)
  fi
  status=$?
  [ $status -ne 0 ] && break
done <<<"$gated"
# Flags but no PR to judge (a GraphQL call, an unreadable query): the gate judges the away rule
# alone. If it cannot run, this denies, like every other gate call.
if [ $status -eq 0 ] && [ -n "$flags" ] && [ -z "$ran" ]; then
  ran=$gate
  out=$(node "$gate" --action merge --flags-only "${extra[@]}" 2>&1)
  status=$?
fi
[ $status -eq 0 ] && exit 0

# Name the gate that ran, so a denial from a stale or unexpected copy is easy to spot.
jq -nc --arg reason "$out" --arg ran "$ran" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: ("pr-review gate" + (if $ran == "" then "" else " (ran " + $ran + ")" end) + ":\n" + $reason)
  }
}'
exit 0
