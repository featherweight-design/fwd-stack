---
name: pr-review
description: Use when reviewing a pull request before it merges — which review a PR gets, triaging findings, and deciding when the merge bar is met. Also governs PR structure — size, splitting, and the ban on stacked PRs. Single source of truth across every repository.
---

# pr-review

**First, read the project's own rules.** If `.claude/fwd/pr-review.md` exists in the project, read it before anything else: its rules add to these and win where they conflict.

Snippets, procedures and evidence live in [reference.md](reference.md); each pointer below says what is there. This skill governs whether the code was read. Whether the feature is actually there is `feature-acceptance`'s job (a review reads a diff and cannot see a route that never got the component); invoke both. Nothing else restates this policy; other skills point here.

## Owner ruling, 2026-10-30, amended 2026-11-08: Claude reviews; Copilot is never requested

Claude reviews every code PR; risky PRs get a second, targeted pass: the risk checklist, aimed at ten classes Claude's review missed (evidence in reference.md). Never request a Copilot review on any PR.

| PR kind                                                                                                                                    | Review                                                                                                                                                                              | Merge bar                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **Risky code**: destructive diff, migrations/schema, DB layer, auth/session/proxy, payments/credits/billing/webhooks, API routes, security | **Claude review, two passes.** `/code-review medium` on the diff, then the risk checklist pass. Fix every valid finding.                                                            | `## Copilot off` + `## Claude review` recording both passes + green CI |
| **Other code**                                                                                                                             | **Claude review.** Dispatch the `caveman:cavecrew-reviewer` agent on the PR diff with the addendum below, fix what it finds, and record it in the PR body under `## Claude review`. | `## Claude review` + green CI                                          |
| **Doc, design, test, probe, script or copy-only**                                                                                          | None. Read your own diff.                                                                                                                                                           | Green CI                                                               |

- The gate classifies the PR (`review scope` line) and enforces this table (`merge bar` line). On a risky PR, write `## Copilot off` in the body; the heading is literal, the gate reads it.
- **The `## Copilot off` door** (plugin 0.1.19): a risky PR with that heading meets its bar only when `## Claude review` is a real record that names `/code-review` and holds a `Checklist pass:` line that is itself a record (`Checklist pass: pending`, or the unfilled hint, is not). The gate says what is missing, and refuses every Copilot request on every PR.
- Destructive diffs take this door too: the two Claude passes are their review; read the diff's deletes and overwrites with the care those rules were written for.
- **`## Risk: not risky`**: risk is what the diff changes, not where it sits. A path-risky PR that only reads or displays (copy, UI, tests) gets this heading and one line of reason; the gate then wants a Claude review only. When unsure, record the call there and default to a Claude review. Ignored for destructive diffs, migrations/schema, API/cron routes, auth/session/middleware/proxy and webhooks (`HARD_RISKY`, `risk-override.mjs`). The `risk override` line prints each use for the month report.
- **Which Claude reviewer.**
  - **Risky PRs: `/code-review medium`, then the risk checklist pass.** After `/code-review medium` has run and its fixes are pushed, dispatch a general-purpose subagent with `${CLAUDE_PLUGIN_ROOT}/skills/pr-review/risk-checklist-prompt.md` as its prompt. Rules are §7's precheck rules: not a fork, the branch only, no plans or handoffs, the same subagent grant, verify every finding before acting. It is a separate pass, not an argument to `/code-review`. It reports Lows on comments, names, probes and selectors (its checks 8 and 9): fix those too.
  - **Other code: `caveman:cavecrew-reviewer`**, a read-only subagent returning one line per finding. Add this to its dispatch prompt:

    ```markdown
    Also check, and report under the same one-line format:

    - every name, switch, label or route the diff removes or renames: `git grep` it on the branch and
      report live hits left (code, tests, scripts, JSON inventories);
    - every changed export or argument list: tests that mock it or assert on its call;
    - each feature switch in the diff, OFF as well as ON: what does the reader see?;
    - useState copied from a prop, a provider without a key, a success path that skips refresh;
    - a probe that presses a route or selector the app does not have, or reads before it cleans up;
    - a changed comment or name that no longer matches the code;
    - the house rules in .claude/fwd/review-rules.md, if the file exists.
    ```

  - House rules live in `.claude/fwd/review-rules.md` in each project; both passes read it.
  - Use no GitHub-side Claude Action; it bills API usage per run.
- **`## Claude review` records** the reviewer used (`cavecrew-reviewer` or `/code-review <level>`), the findings by severity, and what was fixed or declined, in one short paragraph. A risky PR records both passes, the checklist on its own line: `Checklist pass: <n> findings (C/H/M/L), <what was fixed or declined>`, or `Checklist pass: no findings.` The gate rejects an empty section or a placeholder (pending, TBD, todo, n/a, a comment), including a clause that ends on one ("the review is still pending") unless it is prose about the code: a subordinate clause (that, which, while, whose, because) after a subject that is not the review.
- **UI PRs also need `## Design review`**: the `design-review` skill's verify table, written before the PR opens, plus the contact sheet for the routes touched (`feature-acceptance`). A review pass replaces neither. The gate does not check them; the orchestrator does not merge a UI PR without them.
- **A/B v2 line (risky PRs).** Add to `## Claude review`: `A/B v2: Claude <n> (C/H/M/L), checklist-only real <n> [checks], code-review-only real <n>`. A finding is "real" if you fixed it; the bracketed numbers (1 to 10) are the checks that found it. Older `A/B:` lines stay as history.
- **Escapes are tracked four ways** (measured to 2026-11-30, then re-ruled):
  1. A fix PR that repairs a defect an earlier merged PR introduced names it under `## Escaped from #N`.
  2. Each Friday, list the week's merged PRs with `fix`, `revert` or `hotfix` in the title that touch a file a risky PR changed in the prior 14 days, and label each an escape or not (`escape-sweep.mjs`, usage in reference.md).
  3. Every 5th merged risky PR gets a fresh-session `/code-review high` on its merged diff the next day; a real finding is a latent escape. Kept through December.
  4. A red main after a risky merge, or a new runtime error class on a touched route, is checked against the risky PRs.
- **Rollback trigger.** Any Critical or High escape from a risky PR, or more than 1 Medium per 15 risky PRs, ends Claude-only review on risky PRs: stop and report to the owner, who re-rules the review path.
- The rest of this document governs the watcher, how to triage a Claude review, the merge bar and PR structure.

## The gate runs this; you do not have to remember it

`node "${CLAUDE_PLUGIN_ROOT}/skills/pr-review/pr-gate.mjs" <pr> [--action merge|rerequest]`

It prints the state the rules depend on: the PR's risk class, the review it needs and whether that review is recorded, CI on the head, destructive paths, size. With `--action merge` it judges the merge and exits non-zero when a rule forbids it; `--action rerequest` is always refused (Copilot is cut). Run it whenever you are about to act on a PR; never recall the state.

A PreToolUse hook runs it before `gh pr merge` and before a review request and denies the call on non-zero. It reads the command line and fails closed: a merge it cannot attribute to a PR (a wrapper, substitution, heredoc, unknown flag, merge of the current branch) is denied with the plain form to use, `gh pr merge <number> [--repo owner/name]`. A repository the command names (`--repo`, `-R`, an API path) decides; otherwise it is resolved in the directory a plain `cd <path>` leads to, and outside any checkout it is denied. The hook runs the newest installed gate (`~/.claude/fwd`), so a gate fix reaches running sessions without `/reload-plugins`. A denial names the gate path that ran.

## 1 · Pushing

A push triggers no review by itself; Claude review is run by you, per the ruling above.

- **Confirm the push landed.** A chained `git rebase && git push && …` short-circuits silently. Compare `pulls/N` `.head.sha` to `git rev-parse HEAD` (snippet in reference.md); the gate runs it from a checkout of the PR's head branch.
- Two agents on one repository interfere; expect rebase conflicts rather than chaining past them.

## 2 · Waiting

- **Use the shipped watcher, armed once when the PR opens:** `Monitor({ command: 'node "${CLAUDE_PLUGIN_ROOT}/skills/pr-review/pr-watch.mjs" <pr>', description: 'PR <pr> CI and merge', timeout_ms: 1800000 })`. It prints one line per head's CI result and when the PR merges or closes, and keeps running across pushes. When it prints `TIMED OUT`, re-arm it. A hand-rolled poll loop wakes once and then nothing watches.
- **Under Bash `run_in_background`, add `--exit-on-ci`.** A background command wakes you only when it exits, so without the flag a green or red CI sits unnoticed until the 29-minute timeout. With it the watcher exits on the head's first terminal CI state (0 passed, 1 failed) or when the PR ends.
- Subagents cannot run a long wait; it exceeds their window. The orchestrating session owns review, fix and merge. A subagent may open the PR, then return.

## 3 · Triage

- **Fix every valid finding, nits included.** Decline one only when it is technically wrong, conflicts with a ratified decision, or violates YAGNI, and say why in the `## Claude review` paragraph. "Defer for later" is never a reason; a deferral needs explicit user approval before the PR opens.
- **A finding in a test, probe, fixture or script is fixed properly** (sweep its class), but it cannot break production and does not need a second review pass.
- **Findings on a design handoff are not findings** where a project keeps handoffs under `design/` owned by a separate design process. Fix the CODE the handoff describes and leave the handoff alone; a real contradiction with a shipped ruling goes in the readiness doc's errata table.
- **A finding about what something should MEAN is not a review finding.** Questions of meaning (what a legend decodes, what a mark says) go to the design queue as a ticket.
- **The person who owns the product can overrule a ratified spec; you cannot.** When a finding cites a contract the PR breaks, stop and put the evidence to the user as a scope decision.
- **Repeated findings on one small surface mean it is over-built.** Ask whether the code should exist; delete it rather than fix it again.

**"Gate" before a push means typecheck and lint, never tests.** The local gate is typecheck + lint (plus a format check where the project has one), then `git fetch origin && git rebase origin/main`. No tests of any kind run locally: not the full suite, not targeted tests, not a local mutation check, not a local production or stub build. CI is the only test gate, and a PR merges only on green CI (§4). Every other skill that names a pre-push gate means this one. (Why: parallel lanes each running a large suite pushed machine load past 150.) The one exception is a single run the user approves: they arm it with `! node ~/.claude/fwd/hooks/allow-once.mjs "<exact command>" --session=<lane's $CLAUDE_SESSION_ID>` (exact command, one use, 15 minutes, that session only); see the `lane` skill.

CI shape this assumes: related tests on PRs and pushes to main, the full suite nightly on main (schedule and `workflow_dispatch`), and the full suite on lockfile, config, CI or dependency changes or a `ci:full` label. A red nightly goes to the orchestrator.

- **Fix everything a review raised in one push**; never fix-push-fix-push.
- **Mutation-check a fix that ships with a test, in CI or not at all.** Push a commit that deliberately breaks the fix, confirm CI fails on the new test, then push the revert; it proves the test measures anything. If a CI round trip is not worth it, skip the check and do not claim it. Never run it locally.
- **Sweep a class by grep, not by reading.** On the first spelling, wording, formatting or plural nit, grep the whole file for the category and fix every hit in the same push. The same applies to logic: when a fix adds a new conditional, grep every sibling consumer of that data in the file before pushing. A claim that a class is swept must come from a grep command.

## 4 · The merge bar

- **A UI PR first needs its `## Design review` table and contact sheet.** Without them it does not meet the bar.
- The bar for each PR kind is the table above, and the gate decides it; a PR with an unfixed Critical, High or Medium finding does not meet it.
- **Red or pending CI blocks the merge, and the gate enforces it.** Merge in its own command after the checks finish: a chained `gh pr checks --watch && gh pr merge` is judged before the wait runs, so the hook denies it while anything is pending.
- **While the user is away, the merge is judged on what is green now.** `--auto` is banned always. While the shared away window is open (`lib/away.mjs`), the gate also refuses `--admin`, a merge-queue add, the GraphQL mutations that enqueue a PR, turn on auto-merge or merge directly, a `gh api graphql` call whose query it cannot read (a file, stdin, a shell variable), a REST `PUT .../pulls/N/merge`, and any other tool (curl, wget, node, python) whose command text calls `api.github.com` with a `/merge` or `/graphql` path (a text match, so it is conservative), because each lands the PR later, past a failing check or around the gate with nobody watching. Wait for the user, or merge normally with `gh pr merge <number>` once CI is green on the current head; the gate still reads CI live at merge time. Only those flag and mutation forms are detected: a plain `gh pr merge` into a repository that has a merge queue enabled is not recognized as a queue add, and rides on the live CI read alone. Aliases, wrapper scripts and custom hosts (`GH_HOST`) that merge are not detected. A window file that exists but cannot be read counts as open for this rule, and the window is read from every data folder the writer or the hook could resolve. A present user sees no change. The away window never widens authority: it adds refusals only, and it never pre-authorizes a destructive or security-sensitive action. A risky PR still needs its recorded review while away, and a brief cannot waive it.
- **When the bar is met, merge. Do not fix one more thing first.** An outstanding nit rides in the merge commit or becomes a follow-up.
- **Merge yourself once the bar and CI are green**, interactive sessions included. Do not park a green PR on a confirmation. A pending design ratification is not a blocker: record the amendment, merge, and put it in the close-out. Open questions go in the PR body.

## 5 · Doc-only PRs

Briefs, specs, plans, property tables, trackers, READMEs: anything with no runtime. The gate also counts a script edit whose every changed line is a comment, and a `plugin.json` or `package.json` change to the top-level `version` alone, as having none.

- **No review at all** (owner ruling, 2026-10-30). Read the diff yourself, fix what is wrong, and merge on green CI.
- Read your own doc diff for factual errors in a spec, brief or property table (a missing enum case, an evidence table that does not support its claim, a brief describing a route wrongly); they cost a design round later.
- **Bundle doc changes**: multiple in flight belong in one PR.
- Never open a spec-only or plan-only PR: spec, plan and code land together. For a large feature, have a subagent review the plan before implementation.

## 6 · PR structure

**No stacked PRs.** One PR at a time per feature line, based on `main`: open, review, merge, then cut the next off fresh `main`. Stacking looks like parallelism and is not: nothing merges until the root does, every rebase churns every child, and a child's diff contains its parent's work. To drain an existing stack bottom-up, see reference.md.

- **Keep a file under roughly 600 lines**, the per-file ceiling for a review to read it whole; split a large plan into an index plus per-PR sub-files.
- **Split on FILE COUNT, not line count.** Review surface is per-file. Over ~20 files, split (the gate also warns past ~800 runtime lines, excluding prose and generated files, as the weaker signal), and name the PR boundaries **in the plan**, before implementation starts. The natural cut is the plan's task groups (reference.md). If tasks cannot be cut, say so and get agreement before starting.
- **One exception: a single-surface UI PR.** A PR that covers exactly one screen or one component family, with its tests and contact sheet, may go over the file or line bar. Its body must carry a `## Size` section that says why it is not split and names the single surface it covers. The gate keeps warning on size as before; the exception is satisfied by that section, and the review records that it was checked. Everything else must still split: migrations, APIs, mixed surfaces and multi-concern PRs get no exception, and stacked PRs stay banned.

## 7 · The pre-open gate

These stop findings before review. Before opening, run these checks on your own work (detail in reference.md):

1. Every raw `sql` template gets a probe before the PR opens.
2. Never hand-roll a query when a loader exists; grep for a reader of the same table.
3. Load the real route, not the component.
4. Verify a structural claim before writing it down; prove an "impossible" or soften it.
5. Build the acceptance artifacts (contact sheet) before opening.

### The cold-eyes pass — ON TRIAL, run it on every PR

Immediately before `gh pr create`, dispatch a general-purpose subagent (not a fork: a fork knows what you meant) with `${CLAUDE_PLUGIN_ROOT}/skills/pr-review/precheck-prompt.md` as its prompt. It gets the branch and nothing else, no plan or handoff.

- **It needs the user's subagent authorization**, which outranks this skill. A project grants it standing in `AGENTS.md`/`CLAUDE.md` or `.claude/fwd/pr-review.md`; otherwise ask once and skip the pass if declined. The grant covers this pass only.
- **Verify every finding before acting on it.** It generates findings and does not rule on them, and it never gates the PR: fix what is real, note what you declined, open.
- **Record it before opening:** `node "${CLAUDE_PLUGIN_ROOT}/skills/pr-review/precheck.mjs" record <file>` (or `-` for stdin). The ledger lives in the plugin's data folder, never beside these scripts.
- **Run it on EVERY PR while the trial is open**, including ones you feel sure about; a self-selected sample cannot answer the trial's question.
- After the PR's Claude review, score it with `precheck.mjs score <pr> <predicted> <review-total> --fixed=N --shipped=M --kind=K [note]`. `--fixed` is the pass's findings fixed before opening, `--shipped` counts demonstrated reach only, `--kind` is arithmetic, layout, modelling, wiring or prose. Scoring detail and the verdict thresholds are in reference.md.
- **Do not change `precheck-prompt.md` while the trial is open.** Bring the ledger's verdict to the user; the section stays a trial until it exists.

## 8 · Before opening at all

Do not open a PR on content that has not passed your own first assessment. If something upstream must be fixed first (Design owes a token, a handoff has a known gap), surface it and hold. A spec or plan written during a brainstorm is an input to the next step: commit it on a branch and hand over the path; do not push or open a PR until asked.

## Red flags

| Thought                                        | Reality                                                      |
| ---------------------------------------------- | ------------------------------------------------------------ |
| "Bar's met, but let me fix this one nit first" | Merge. The nit rides along or becomes a follow-up. §4.       |
| "A probe has a real bug, that's a finding"     | A probe cannot break production. Fix it, no second pass. §3. |
| "I read the file, the class is swept"          | Swept means a grep produced the claim. §3.                   |
| "The test passes, the fix works"               | Push a commit that breaks the fix; CI must go red. §3.       |
| "Bar's met but I'll check before merging"      | Merge. Open questions go in the body. §4.                    |
| "I'll stack the next slice on this branch"     | No stacked PRs. §6.                                          |
| "A subagent can wait out the CI"               | The wait exceeds its window. §2.                             |
| "The review passed, so the feature is there"   | Review reads diffs. Load the routes: `feature-acceptance`.   |
| "Copilot would catch this"                     | It is never requested. Claude review per the table above.    |
| "The gate is blocking me, I'll work around it" | It is quoting a rule you wrote. Read the reason.             |
