# complete-and-ship reference

Procedures and templates SKILL.md links to. Read a section only when SKILL.md sends you here.

## Flow

Kickoff (interactive) -> confirm plan -> user says go -> Step 0 bootstrap -> 0e design enumeration -> Step 1 allowlist -> Step 2 tasks (commit per task; run 2.5 after API tasks, before UI tasks) -> Step 3 quality gate -> Step 4 spec and design comparison with a committed gap report (implement gaps, get approval for any deferral) -> Step 5 env vars -> 5b copy review if the diff has copy -> Step 6 open PR -> Step 7 first review request, watcher armed -> Steps 8-9 triage, rebase, push -> Step 10 CI, then merge when pr-review's gate allows -> Step 11 report.

## Step 0 commands

```bash
# 0a. The main checkout is the first entry `git worktree list` prints.
MAIN_REPO="$(git worktree list --porcelain | sed -n '1s/^worktree //p')"
git -C "$MAIN_REPO" fetch origin
git -C "$MAIN_REPO" merge --ff-only origin/main   # if it fails, local main diverged: stop and ask

# 0b. Worktree location is a default; the project's extension may name another. Keep it gitignored.
BRANCH="<branch-name>"
WORKTREE="$MAIN_REPO/.worktrees/$BRANCH"
git -C "$MAIN_REPO" worktree add "$WORKTREE" -b "$BRANCH"

# 0c. Copy the handoff only if it is untracked on the branch. Copy CONTENTS ("/."), no .env*, node_modules or build output.
ASSETS="<design-asset-path>"   # no trailing slash
if git -C "$WORKTREE" ls-files --error-unmatch "$ASSETS" >/dev/null 2>&1; then
  echo "handoff already tracked; skip 0c and 0d"
else
  mkdir -p "$WORKTREE/$ASSETS"
  cp -R "$MAIN_REPO/$ASSETS/." "$WORKTREE/$ASSETS/"
fi

# 0d. Commit it (nothing staged is fine).
git -C "$WORKTREE" add "$ASSETS"
git -C "$WORKTREE" diff --cached --quiet \
  || git -C "$WORKTREE" commit -m "chore: add design handoff assets for <feature-name>"
```

## Step 0e: property table

Run `design-review` Agent 1 (enumerate) on the design files only, save `docs/superpowers/design-tables/<feature>.md`, commit it (`docs: design property table for <feature>`), reference it in the plan and pass it to each execution subagent. It is the input to Agent 2 in Step 4. Without it Step 4 needs two agents and implementation builds blind.

## Step 1: allowlist for a fresh agent

Write to the worktree's `.claude/settings.local.json` (not committed), merging into any existing `permissions.allow`; swap `pnpm` for the project's package manager and add project tools as they surface:

```json
{
  "permissions": {
    "allow": [
      "Bash(git *)",
      "Bash(pnpm *)",
      "Bash(gh *)",
      "Bash(cp -R *)",
      "Bash(mkdir *)",
      "Bash(cat *)"
    ]
  }
}
```

## Step 2.5: API contract gate, in full

For every state in the design's state coverage table (columns like State, Trigger, Visual): identify the triggering API field and value; check the field is in the TypeScript response type; check the route actually computes and assigns it (look for `= null` stubs, missing queries, paths where it is never set). Mark each state:

- ✅ Contract verified: the field is in the type AND the route computes it.
- ⚠️ Type present, route incomplete: the route always returns `null` or never sets it.
- ❌ Not surfaced: the field is not in the response type.

On ⚠️ or ❌, stop before UI tasks. Fix the route (preferred; usually a small addition) or ask: "State X is not reachable because the API doesn't return [field]. Implement now, or defer with your explicit approval?" A component that renders correctly for the right props but is never given them looks identical to a working one until someone tries the state.

## Step 4: sub-steps

- **4a-ii design-review sequence.** With a property table, run Agent 2 (verify) on table plus implementation; without one, run Agent 1 then Agent 2. Fix all gaps at once, re-run the quality gate, run Agent 3 (confirm) on the gap list only; if it still finds gaps, fix and re-run Agent 3 once more on those items. If gaps remain, list them in the gap report and tell the user. Four agent calls at most. Put the verified rows in the PR body under `## Design review`.
- **4b spec sources**, in order: the plan file's header, a spec linked in `CLAUDE.md` under the current phase, the most recently modified matching spec in `docs/superpowers/specs/`.
- **4c** Read the spec top to bottom and list every named requirement, API contract, interaction, state (loading, empty, error) and non-functional requirement the property table did not cover; check source, routes, components and tests; mark implemented or gap.
- **4d gap report** at `docs/superpowers/gap-report-<feature>.md`:

```markdown
# Gap Report — <Feature Name>

## IMPLEMENTED (N)

- ComponentName — requirement satisfied [file:line]

## GAPS (N)

- ComponentName — what's missing/wrong [file:line]

## DEFERRED (N)

- ItemName — reason: <explicit reason>
```

Commit it (`docs: design gap report for <feature>`) before anything else, implement every non-deferred gap, return to Step 3, then update the report to all IMPLEMENTED and commit again.

- **4e deferral.** Allowed only when the item needs a product decision, credential or third-party integration that cannot proceed without a human, or the spec marks it a future phase and nothing implemented depends on it. Ask: "I need to defer [item] because [reason]. This affects [what won't work]. Can I proceed?" and wait. After approval, list it in the PR body under **Deferred** with the reason and approval.

## Step 5: env var scan

```bash
git diff main...HEAD -- '*.env.example' | grep '^+' | grep -v '^+++'
git diff main...HEAD -- '*.ts' '*.tsx' | grep '^+' | grep 'process\.env\.'
```

For each new variable collect: name, purpose (one line), service (as named in the hosting config), environment (staging, production or both), GitHub secret (yes/no, for CI workflows or smoke tests), and how to provision it.

## Step 5b: copy gate details

Triggers (from `git diff main...HEAD --name-only`): a file in the copy inventory named by `.claude/fwd/copy-review.md` (copy definitions, release notes, changelog entries), an email or push template, a design handoff containing copy, or a new inline user-visible string in a component.

```bash
# Example only: COPY_PATHS is the inventory's patterns as one anchored ERE.
COPY_PATHS='(^|/)definitions/copy\.ts$|(^|/)emails?/|(^|/)notifications/push/|(^|/)design_handoff_[^/]+/'
git diff main...HEAD --name-only | grep -E "$COPY_PATHS"
```

Anchor on path segments: a bare `email` or `push` matches `emailValidator.ts` and `pushState.ts`, and a gate that fires on everything gets ignored.

Inline strings: if the lint config enables a rule forbidding inline literals (such as `react/jsx-no-literals`), clean lint covers JSX text only; read the lint config itself, not a note about it. Read the diff by hand for strings the rule cannot see: arguments to `toast.error(...)`, strings assigned to variables or constants, error messages that reach the screen.

## Step 6: PR body template

Use the project's PR template (`.github/pull_request_template.md` or `.github/PULL_REQUEST_TEMPLATE/`) as the base and fold these in; otherwise use as is. Push the branch first (`git push -u origin HEAD`) because `gh pr create` aborts without a remote head in an unattended run. Follow the project's convention on AI attribution.

```markdown
## Summary

- <bullet>

## Test plan

- [ ] Type-check passes
- [ ] Lint passes
- [ ] CI passes (tests run in CI only)
- [ ] Manual smoke: <what to click/verify>

## Design review

<!-- UI PRs: the design-review verify table and the contact sheet. Omit otherwise. -->

## Spec coverage

- All spec and design requirements implemented

<!-- OR deferred items with the reason and the user's approval -->

## New environment variables

<!-- Omit if none -->

| Variable   | Purpose      | Service   | Environment    | GH Secret | How to provision  |
| ---------- | ------------ | --------- | -------------- | --------- | ----------------- |
| `VAR_NAME` | What it does | <service> | staging + prod | No        | <where to get it> |
```

## Step 8: severity signals

- Critical/High: "bug", "error", "security", "breaks", "incorrect", "unsafe", "missing validation", "race condition".
- Medium: "should", "missing", "consider adding", "incomplete", "unclear", "inconsistent".
- Low/Nit: "prefer", "nit", "optional", "consider", "minor", "style".

"Consider" alone is Low at most; "should" and "missing" are Medium. When in doubt, Medium.

## Step 9: rebase conflicts

Resolve conflicts file by file (`git add <file>`, then `git rebase --continue`). If the rebase is too complex to resolve safely, stop and tell the user before any `git rebase --abort`.

## Session continuity: recovery entry points

| If interrupted after...             | Resume at                                                                  |
| ----------------------------------- | -------------------------------------------------------------------------- |
| Step 0 (worktree/assets)            | Check worktree exists; check design assets committed; re-run missing parts |
| Step 2 (some tasks done)            | Re-read plan, execute remaining unchecked tasks                            |
| Step 3-4 (quality gate / spec work) | Re-run quality gate, re-verify spec and design assets                      |
| Step 5-6 (env scan / PR open)       | Check if PR exists (`gh pr list`); create if not, skip if already open     |
| Step 7 (review)                     | Re-arm pr-review's watcher; check the PR body records the Claude review    |
| Step 8-9 (fixes pushed)             | Run pr-review's gate; resume any owed triage or push, then 10              |
| Step 10 (watching CI)               | Re-run `gh pr checks --watch`; merge if the bar and CI are green           |

Detect an open PR with `gh pr list --head $(git branch --show-current) --json number,url`. Past several compactions with drift, commit, fix the plan checkboxes, write the exact next action in `## Resume`, and tell the user one line: "Session at limit — committed through [step]. Resume with `/complete-and-ship`."

## Subagent return contract

When stopping at the end of Step 7, the final message holds exactly these four things, in order:

1. PR URL.
2. Branch name.
3. State summary, one short line each: CI status (`green` / `running` / `failed: <check>`); first review (`review requested (verified on timeline)` when one was requested); open ends (env vars to provision, deferrals approved, follow-up issues). For a follow-up needing Design input, confirm a row was added on this branch to the design pipeline tracker that `design-status` reads; it never queries issue labels, so a design-labelled ticket with no tracker row is invisible. Judge by the fix, not the label: a missing affordance, a placement call or a new surface is design work even when filed as a bug.
4. Branch SHA at hand-off (`git rev-parse --short HEAD`).

## Invocation examples

```
/complete-and-ship

Feature: Admin UI Redesign
Design assets: design/design_handoff_admin_ui/
Plan file: docs/superpowers/plans/<file>.md   (optional; skips planning)
```

For no handoff, write `Design assets: none`.
