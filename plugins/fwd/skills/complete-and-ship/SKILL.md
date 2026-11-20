---
name: complete-and-ship
description: Use when a plan's remaining tasks need to be executed unattended, followed by opening a PR, requesting Copilot review, triaging feedback, and pushing the final result.
---

# complete-and-ship

**First, read the project's own rules.** If `.claude/fwd/complete-and-ship.md` exists in the project, read it before anything else: it names the project's own tools and conventions for this skill, and its rules add to these and win where they conflict.

Kick off interactively, then run unattended: bootstrap a feature worktree, complete the plan's tasks, verify against the spec and design handoff, open a PR, run the review cycle per `pr-review`, and confirm CI. Commands, templates and tables are in [reference.md](reference.md); the step flow is at its top.

## Kickoff (interactive)

The only interactive phase. Ask in a **single message**: (1) feature or phase, (2) branch name (propose `feat/<feature>` if not given), (3) design handoff path relative to the repo root, or "none", (4) plan file path, or the scope so you can draft one.

Then: read the plan and summarize outstanding tasks, or draft one with `superpowers:writing-plans` and get approval. Confirm branch, worktree, plan file, design assets and tasks remaining in one message, ask **"Ready to proceed? I'll run everything else autonomously."**, and **wait for the user to say go** before Step 0.

## 0. Worktree and design asset bootstrap

First thing a fresh agent does, before any implementation (commands in reference.md).

- **0a.** Fast-forward local `main` to `origin/main` in the main checkout. If `--ff-only` fails, stop and ask; never force-reset.
- **0b.** Create the feature worktree and branch from `main`, gitignored (the project's extension may name the location). All later work runs in the worktree.
- **0c/0d.** The design handoff travels with the branch. If it is untracked, copy the whole folder's contents to the same relative path (no `.env*`, node_modules or build output) and commit it; if already tracked, skip both.
- **0e. HARD GATE: Step 2 does not start until this is done.** If handoff files exist, run `design-review` Agent 1 (enumerate) on the design files only, save `docs/superpowers/design-tables/<feature>.md`, commit it, reference it in the plan and pass it to every execution subagent. No handoff: skip.

## 1. Pre-authorize commands

Interactive session: invoke `fewer-permission-prompts`. Fresh agent (empty transcript): write the known allowlist to the worktree's `.claude/settings.local.json` (reference.md).

## 2. Complete remaining tasks

Use `superpowers:executing-plans` on every unchecked task, in order. **Commit after each task** with a conventional message so a fresh session resumes from the last checkpoint.

## 2.5 API contract verification gate

**HARD GATE** when the plan has both API and UI tasks: after the API tasks and before any UI task, check every state in the design's state coverage table. Name its triggering API field, check it is in the response type, and check the route actually computes it. Any state marked ⚠️ (type present, route incomplete) or ❌ (not surfaced) stops UI work: fix the route, or ask the user to approve a deferral. Never assume a UI state will "just work" later. Skip only for UI-only features (details in reference.md).

## 3. Quality gate

Run typecheck and lint (and a format check where the project has one) for every app touched, using the project's commands. Do not run tests or a production build locally: CI is the only test gate (pr-review §5). Write tests with the code. Fix errors before the spec comparison.

## 4. Compare implementation to the design spec and assets

> **ABSOLUTE HARD GATE: `gh pr create` does not run until Step 4 yields a written gap report, committed to the branch, with every gap implemented or approved-deferred.** "I checked in my head" is not acceptable.

- **4a.** Invoke `feature-acceptance` first (contact sheet, marker checks, import equality for every route x viewport touched) and attach the contact sheet to the PR. Then, if a handoff exists, run `design-review`: Agent 2 (verify) against the property table (Agent 1 first if none exists), fix all gaps at once, re-run Step 3, then Agent 3 (confirm) on the gap list only, with at most one re-run. Four agent calls at most. Put the verified rows in the PR body under `## Design review`; a UI PR does not merge without it. No handoff: go to 4b.
- **4b/4c.** Read the written spec (plan header, `CLAUDE.md` link, or `docs/superpowers/specs/`) top to bottom and check every requirement, contract, state and non-functional item the property table did not cover against source, routes, components and tests.
- **4d.** Write `docs/superpowers/gap-report-<feature>.md` (IMPLEMENTED, GAPS, DEFERRED; format in reference.md) and commit it first. Implement every non-deferred gap, return to Step 3, then update the report and commit again.
- **4e. Deferrals are never unilateral.** Defer only for a product decision, credential or third-party integration that needs a human, or an explicit self-contained future phase. "Hard" and "time-consuming" are not reasons; when in doubt, implement. Stop before opening the PR, tell the user the item, the reason and what will not work, and wait for explicit approval. Then list it in the PR body under **Deferred**.

## 5. Scan for new environment variables

Confirm Step 4 is complete first. Detect new env vars on the branch (`.env.example` additions, new `process.env.` references) and collect name, purpose, service, environment, GitHub-secret need and how to provision (commands in reference.md). The list goes in the PR body.

## 5b. Copy review gate

If the diff touches customer-facing copy, run `copy-review` over it and apply its findings before `gh pr create`. Triggers: a file in the copy inventory named in `.claude/fwd/copy-review.md`, an email or push template, a design handoff containing copy, or a new inline user-visible string. Anchor any path patterns on path segments. A lint rule forbidding inline literals covers JSX text only; read the diff for strings it cannot see (toast arguments, constants, error messages). No match: skip to Step 6 and say so. Match: run `copy-review`, fix, re-run Step 3. The binding's frozen areas are not yours to rewrite: flag drift to the user.

## 6. Open PR

Push the branch first (`git push -u origin HEAD`), after the pre-PR gates pass. Use the project's PR template as the base, else the sections in reference.md: Summary, Test plan, Design review (UI PRs), Spec coverage and deferrals, New environment variables. Name a body file after the PR or branch (`<branch>-body.md`), never `pr-body.md`, and read it back before any `--body-file`. Follow the project's convention on AI attribution.

## 7. Request review

**Invoke `pr-review` and follow it.** It owns requests, the watcher (`pr-watch.mjs`, armed once via `Monitor` and left running), the stale-review check, what counts as a finding, when a fix earns a re-request, convergence and the merge bar. Run no step from memory and hand-roll no polling loop.

- If no review arrives on the **first** request within pr-review's waiting window, leave a PR comment "Copilot review pending — will triage when it arrives." and tell the user before pushing more. Do not merge without a successful review. If Copilot errors 3+ times over hours, ask the user; never invent an errored-out fallback.
- Re-request only where pr-review says the fix earns one.

## 8. Triage all comments

Triage per `pr-review` (severity table, nit and sweep rules, CI-only mutation check, `## Settled`). **Three consecutive rounds on the same function or component means a scope decision, not another fix.** When in doubt, treat a finding as Medium (severity signals in reference.md). Fix every valid finding, nits included.

## 9. Rebase and push

`git fetch origin && git rebase origin/main` before pushing. Resolve conflicts file by file; if too complex to resolve safely, stop and tell the user before aborting. Plain `git push` when the rebase was a no-op; `git push --force-with-lease` only when it actually rewrote commits.

## 10. CI gate and merge

After pushing, watch CI (`gh pr checks <PR> --watch`; pr-review's watcher also reports it). On failure: read `gh run view <RUN_ID> --log-failed`, fix the root cause, re-run Step 3, push, re-watch. An environment-specific failure that code cannot fix goes to the user with the error and run ID; do not loop.

**Merge.** With CI green on the head and pr-review's bar met, merge yourself as pr-review §8 directs: run its gate with `--action merge`, merge in its own command after checks finish, no auto-merge flags, no parking a green PR on a confirmation, no fixing one more thing first. A dispatched subagent never reaches this step; neither does a session whose extension or user reserves merging for a human (stop before merging and say so).

## 11. Report

Tasks completed; spec and design gaps found and implemented; deferrals with reasons; new env vars with provisioning table; PR URL; CI status; merge status (SHA, or why not); review comments by severity; low/nit notes left on the PR; inline fixes.

## Session continuity

Commit at every task boundary, tick the plan file's checkboxes, and note the current step in a `## Resume` section if mid-flow. The plan file is the resume token: a fresh session reads it, detects an open PR (`gh pr list --head <branch>`), and resumes at the right step (table in reference.md). Context size and compaction are never a limit: the harness compacts at the configured window (`run-project` §6), so keep the plan file current and keep working. While the user is away, never stop for context. If a session has compacted several times and drifts, commit, fix the checkboxes, write the exact next action in `## Resume`, and tell the user in one line.

## When invoked as a subagent (Agent tool dispatch)

**Stop at the end of Step 7 (first review requested) and return.** Steps 8-10 belong to the orchestrator; a subagent's runtime is bounded and a review cycle is not. Do the bounded work, hand off the rest.

- The final message holds exactly four things in order: PR URL, branch name, a state summary (CI status, first review requested and verified on the timeline, open ends including a design pipeline tracker row for any follow-up needing Design input), and the branch SHA at hand-off. Format in reference.md.
- Do not use `Monitor` to wait for reviews, loop on `ScheduleWakeup`, or address findings yourself; do not poll beyond the first request.
- This section does not apply when you ARE the user's session (run through Step 11), or when the plan tells you to handle the full cycle inline.

## Autonomous operation

Do not pause for routine operations: reading files, editing source, config, CSS and tests, `pnpm`, `tsc`, `eslint`, `git add/commit/push` (never a local test run), `gh pr create/edit/view/checks`, `gh run view`, merging once pr-review's gate allows, plan files, copying design assets, `superpowers:*` skills and their sub-operations, and writing the allowlist.

**Never** read, log, print or commit secrets, keys or PII; include `.env.local` or any non-`.example` env file in commits or PR text; or echo env values into output or comments.

**Stop and tell the human only when:** a task instruction is ambiguous enough that you would guess intent; a quality gate fails with an unclear cause after one honest fix attempt; a Critical/High finding has a non-obvious fix; an action is destructive or irreversible outside the repo (production migrations, force-push to main); a requirement needs a decision, credential or integration; or a CI failure is environment-specific. If it is in the repo and reversible via git, proceed.

## Rules

- Never skip Step 0: worktree isolation and committed design assets are required.
- Never skip the quality gate; never use `--no-verify`.
- Never skip the spec and design comparison, and never open a PR before Step 4 is complete with the gap report committed and updated to final status.
- Never defer without user approval before the PR opens, and list every deferral in the PR body.
- Never begin UI tasks when the API contract is incomplete (Step 2.5).
- Merge when pr-review's gate allows, not before and not after, unless the extension or the user reserves merging for a human.
- Fix every valid finding, nits included; re-request only where `pr-review` says the fix earns a round. Force-push only when a rebase rewrote commits.
- Document every new env var, and confirm CI is green before reporting complete: a passing local gate is not passing CI.
- If a fix introduces new errors, fix those before pushing, and commit at every task boundary.

## Required sub-skills

`fewer-permission-prompts` (Step 1, interactive), `superpowers:executing-plans` (Step 2), `copy-review` (5b), `design-review` (Agent 1 at 0e, Agents 2-3 at 4a), `feature-acceptance` (4a, first), `pr-review` (Steps 7-8 and the merge bar in 10).
