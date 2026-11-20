---
name: pr-review
description: Use when running a GitHub Copilot review cycle on a pull request — requesting the review, waiting for it, deciding whether a round counts, triaging findings, pushing back, and deciding when the merge bar is met. Also governs PR structure — size, splitting, and the ban on stacked PRs. Single source of truth across every repository.
---

# pr-review

**First, read the project's own rules.** If `.claude/fwd/pr-review.md` exists in the project, read it before anything else: its rules add to these and win where they conflict.

Snippets, procedures and evidence live in [reference.md](reference.md); each pointer below says what is there. This skill governs whether the code was read. Whether the feature is actually there is `feature-acceptance`'s job (a review reads a diff and cannot see a route that never got the component); invoke both. Nothing else restates this policy; other skills point here.

## Owner ruling, 2026-10-30, amended 2026-11-08: Claude reviews, Copilot is off. This overrides §1, §5, §7 and §8 below

No PR requests a Copilot review, risky ones included. Claude reviews every code PR; risky PRs get a second, targeted pass: the risk checklist, aimed at ten classes Claude's review missed (evidence in reference.md).

| PR kind                                                                                                                                    | Review                                                                                                                                                                                          | Merge bar                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **Risky code**: destructive diff, migrations/schema, DB layer, auth/session/proxy, payments/credits/billing/webhooks, API routes, security | **Claude review, two passes.** `/code-review medium` on the diff, then the risk checklist pass. Fix every valid finding. No Copilot.                                                            | `## Copilot off` + `## Claude review` recording both passes + green CI |
| **Other code**                                                                                                                             | **Claude review.** Dispatch the `caveman:cavecrew-reviewer` agent on the PR diff with the addendum below, fix what it finds, and record it in the PR body under `## Claude review`. No Copilot. | `## Claude review` + green CI                                          |
| **Doc, design, test, probe, script or copy-only**                                                                                          | None. Read your own diff.                                                                                                                                                                       | Green CI                                                               |

- The gate classifies the PR (`copilot scope` line), enforces this table, and refuses any Copilot request on a non-risky PR. On a risky PR, write `## Copilot off` in the body and request nothing.
- **The `## Copilot off` door** (plugin 0.1.19): a risky PR with that heading meets its bar only when `## Claude review` is a real record that names `/code-review` and holds a `Checklist pass:` line that is itself a record (`Checklist pass: pending`, or the unfilled hint, is not). A Copilot round already on the PR, or a `## Copilot budget stop`, does not stand in for it. The gate prints a `copilot off` line on every PR that declares the heading, says what is missing, and refuses every Copilot request while the heading is there.
- Destructive diffs take this door too: the two Claude passes are their review, so §8's clean-after-clean and §7's "the merge waits for the user" do not apply; read the diff's deletes and overwrites with the care those rules were written for. Without the heading the gate still accepts one Copilot round on a risky PR; that path exists only for the rollback trigger below.
- **`## Risk: not risky`**: risk is what the diff changes, not where it sits. A path-risky PR that only reads or displays (copy, UI, tests) gets this heading and one line of reason; the gate then wants a Claude review only. When unsure, record the call there and default to a Claude review. Ignored for destructive diffs, migrations/schema, API/cron routes, auth/session/middleware/proxy and webhooks (`HARD_RISKY`, `risk-override.mjs`). The `risk override` line prints each use for the month report.
- **Budget stop.** The `## Copilot budget stop` door is still in the gate; do not use it.
- **Which Claude reviewer.**
  - **Risky PRs: `/code-review medium`, then the risk checklist pass.** After `/code-review medium` has run and its fixes are pushed, dispatch a general-purpose subagent with `${CLAUDE_PLUGIN_ROOT}/skills/pr-review/risk-checklist-prompt.md` as its prompt. Rules are §10b's precheck rules: not a fork, the branch only, no plans or handoffs, the same subagent grant, verify every finding before acting. It is a separate pass, not an argument to `/code-review`. It reports Lows on comments, names, probes and selectors (its checks 8 and 9): fix those too.
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
- **A/B v2 line (risky PRs).** Add to `## Claude review`: `A/B v2: Copilot off, Claude <n> (C/H/M/L), checklist-only real <n> [checks], code-review-only real <n>`. A finding is "real" if you fixed it; the bracketed numbers (1 to 10) are the checks that found it. Older `A/B:` lines stay as history.
- **Escapes are tracked four ways** (measured to 2026-11-30, then re-ruled):
  1. A fix PR that repairs a defect an earlier merged PR introduced names it under `## Escaped from #N`.
  2. Each Friday, list the week's merged PRs with `fix`, `revert` or `hotfix` in the title that touch a file a risky PR changed in the prior 14 days, and label each an escape or not (`escape-sweep.mjs`, usage in reference.md).
  3. Every 5th merged risky PR gets a fresh-session `/code-review high` on its merged diff the next day; a real finding is a latent escape. Kept through December.
  4. A red main after a risky merge, or a new runtime error class on a touched route, is checked against the risky PRs.
- **Rollback trigger.** Any Critical or High escape from a risky PR, or more than 1 Medium per 15 risky PRs, ends Claude-only review on risky PRs: stop, report to the owner, and give risky PRs one Copilot round again until re-ruled.
- The rest of this document governs how to read and triage a review: staleness, findings, sweeping a class, `## Settled`, PR structure. Read "round" as a review pass.

## The gate runs this; you do not have to remember it

`node "${CLAUDE_PLUGIN_ROOT}/skills/pr-review/pr-gate.mjs" <pr> [--action merge|rerequest]`

It prints the state every rule depends on: round count, what each round's findings landed on, whether the last review saw the current head, trailing successful rounds, a surface drawing findings three rounds running, files added after round 3. With `--action` it judges that action and exits non-zero when a rule forbids it. Run it whenever you are about to act on a PR; never recall the state.

A PreToolUse hook runs it before `gh pr merge` and before a review re-request and denies the call on non-zero. It reads the command line and fails closed: a merge it cannot attribute to a PR (a wrapper, substitution, heredoc, unknown flag, merge of the current branch) is denied with the plain form to use, `gh pr merge <number> [--repo owner/name]`. A repository the command names (`--repo`, `-R`, an API path) decides; otherwise it is resolved in the directory a plain `cd <path>` leads to, and outside any checkout it is denied. The hook runs the newest installed gate (`~/.claude/fwd`), so a gate fix reaches running sessions without `/reload-plugins`. A denial names the gate path that ran.

## Change freeze — in effect from 2026-09-18

Do not add or tune a rule in this document without new measured evidence; fix defects in the gate freely. Do not add a check to `risk-checklist-prompt.md` without a class that escaped more than once. Concurrent agents agreeing is one observation, not independent evidence. Evidence and door counts: reference.md.

## Why this exists

The goal is not fewer rounds but rounds that each read new code. Judge every rule by whether it removes a ROUND, not whether it makes one cheaper: latency is the cost, so §5's class-sweep rule is the highest-value rule here. Review is best at arithmetic, platform quirks, and tests that measure nothing.

## 1 · Requesting a review

Copilot does not auto-review and a push triggers nothing. Under the ruling above it is never requested; the legacy request and verify procedures, the wedged-run restart (`restart-review.mjs`) and the exhausted-Copilot case are in reference.md. The gate judges a request: `--action rerequest`.

- A request's 200 is not proof and an empty `requested_reviewers` proves nothing; verify on the timeline, and give a request two minutes before treating absence as absence.
- **Confirm the push landed before counting a round.** A chained `git rebase && git push && …` short-circuits silently. Compare `pulls/N` `.head.sha` to `git rev-parse HEAD` (snippet in reference.md); the gate runs it from a checkout of the PR's head branch.
- Two agents on one repository interfere; expect rebase conflicts rather than chaining past them.

## 2 · Waiting

- **Use the shipped watcher, armed once when the PR opens:** `Monitor({ command: 'node "${CLAUDE_PLUGIN_ROOT}/skills/pr-review/pr-watch.mjs" <pr>', description: 'PR <pr> reviews, CI and merge', timeout_ms: 1800000 })`. It prints one line per new review (fresh, STALE or errored), per head's CI, and for the merge, and keeps running across re-requests. When it prints `TIMED OUT`, re-arm it. A hand-rolled `until the count rises; exit` loop wakes on round 1 and then nothing watches.
- **Under Bash `run_in_background`, add `--exit-on-ci`.** A background command wakes you only when it exits, so without the flag a green or red CI sits unnoticed until the 29-minute timeout. With it the watcher exits on the head's first terminal CI state (0 passed, 1 failed) or when the PR ends.
- A hand-rolled poll runs every ~240-270s and counts reviews whose `.user.type == "Bot"` (the bare login `"Copilot"` matches nothing). Poll the count above where it started; an emptied `reviewRequests` does not mean a review landed. Your own replies create review records: filter them out.
- Subagents cannot run this cycle; the wait exceeds their window. The orchestrating session owns request, wait, triage, fix, re-request, merge. A subagent may open the PR and fire the first request, then return.

## 3 · Before triaging: is this review stale?

**Required, every round, before reading a single finding.** Compare the last bot review's `commit_id` with the branch head from the ref (`git ls-remote origin refs/heads/BRANCH`), not the PR API, which lags by seconds (snippet in reference.md). If they differ, the review never saw your last push: **discard it unread and re-request.** Do not triage it, answer it, or write "declined, already fixed" replies to it.

## 4 · What counts as a finding

**Only inline comments and suppressed comments.** Read the full review body, never the header.

- The summary verdict (🟢 _Approval recommended_, 🟡 _Changes recommended_, 🔵 _Needs a closer look_) is **never a gate**, in either direction; it restates threads you already fixed. 🔵 "warrants final human review" is an advisory on a broad diff, not a finding.
- **Suppressed comments are findings.** They live in the review body only (`<details><summary>Suppressed comments (N)</summary>`), never in the inline-comments API; dump full bodies before judging a round (command in reference.md).
- **Errored reviews count for nothing, in either direction.** "Copilot encountered an error…" is not a round and must not break a clean streak; the gate drops them. Retry immediately, then once at 120s, then hand it to the user. Do not apply §1's escalating backoff to an error.
- **A finding in a test, probe, fixture or script is Low by definition**, even a vacuous test: it is fixed without earning another round. "Cannot break production" is a rule about rounds, not value: fix these properly, sweep their class, mutation-check them in CI, and do not buy a round with them.
- A **successful round** has no new inline or suppressed comment, or only Low/Nit ones, whatever the header says. A round that raised nothing inline and did not say `Changes recommended` is successful too (🔵 with two suppressed comments is a reviewer describing the diff). Read the findings and fix what is valid, but do not spend a round proving it. `Changes recommended` always counts, whatever it landed on. **The header can lower a round's weight, never raise it**, and never excuses reading the findings.
- **Findings on a design handoff are not findings** where a project keeps handoffs under `design/` owned by a separate design process. Fix the CODE the handoff describes and leave the handoff alone; a real contradiction with a shipped ruling goes in the readiness doc's errata table and in a `## Settled` entry naming the file, which makes the gate discount it.

## 5 · Triage

| Severity                                                  | Action                                               |
| --------------------------------------------------------- | ---------------------------------------------------- |
| Critical / High — correctness, security, broken contracts | Fix → gate → push → re-request                       |
| Medium — naming, missing validation, minor logic          | Fix → gate → push → re-request                       |
| Low / Nit                                                 | Apply if valid and cheap; does not reset the counter |

**"Gate" before a push means typecheck and lint, never tests.** The local gate is typecheck + lint (plus a format check where the project has one), then `git fetch origin && git rebase origin/main`. No tests of any kind run locally: not the full suite, not targeted tests, not a local mutation check, not a local production or stub build. CI is the only test gate, and a PR merges only on green CI (§8). Every other skill that names a pre-push gate means this one. (Why: parallel lanes each running a large suite pushed machine load past 150.)

CI shape this assumes: related tests on PRs and pushes to main, the full suite nightly on main (schedule and `workflow_dispatch`), and the full suite on lockfile, config, CI or dependency changes or a `ci:full` label. A red nightly goes to the orchestrator.

- **Fix every valid comment, including nits.** Never offer "fix the bug, defer the nits"; a deferral needs explicit user approval before the PR opens.
- **Doc-sync findings do not reset the counter, and the gate honours that** only when you name the paths in a `## Doc-sync` section of the PR body, as `## Settled` names declined ones; otherwise the gate scores the round substantive. PR-description↔code mismatches, stale comments, plan-doc references and migration-number drift are doc-sync: fix them same-round. A finding revealing a behaviour, type or logic issue is not. An entry is one line per finding, names its round, and covers that round only.
- **A push does not oblige a re-request.** Re-request only after fixing a Critical, High or Medium finding in production code; everything else is fixed, pushed and merged with no new round:

  | Fixed                                                       | Re-request? |
  | ----------------------------------------------------------- | ----------- |
  | Crit/High/Med in `src/` (or the equivalent production tree) | Yes         |
  | Documentation, JSDoc, code comments, PR-body mismatch       | No          |
  | Naming, wording, formatting, plurals                        | No          |
  | Anything in a test, probe, fixture, or `scripts/`           | No          |
  | Anything Copilot itself calls non-blocking or a nit         | No          |

  The row is decided by the files the fix changed, not where the finding was anchored; no `## Settled` entry is needed. On a tooling PR the script is production code, and on a PR whose deliverable is text, findings on the text are the product, not doc-sync (reference.md).

- **Batch the round.** Fix everything a round raised in one push, then one re-request; never fix-push-fix-push.
- **Mutation-check a fix that ships with a test, in CI or not at all.** Push a commit that deliberately breaks the fix, confirm CI fails on the new test, then push the revert; it proves the test measures anything. If a CI round trip is not worth it, skip the check and do not claim it. Never run it locally.
- **Sweep a class by grep, not by reading.** On the first spelling, wording, formatting or plural nit, grep the whole file for the category and fix every hit in the same push. The same applies to logic: when a fix adds a new conditional, grep every sibling consumer of that data in the file before pushing. A claim that a class is swept must come from a grep command. The gate prints the previous round's finding text beside the current one so a repeated cause is visible.

## 6 · Push-backs: once, in writing, machine-visible

Push back when a comment is technically wrong, conflicts with a prior ratified decision, or violates YAGNI, stating the standard it rests on. "Defer for later" is never a reason.

**Record it in a `## Settled` section of the PR body:** the finding and the reason it was declined. Write the body with REST, not `gh pr edit --body-file` (which can silently write nothing), and read it back (commands and a `## Settled` example in reference.md). Name every scratch file after its PR or task (`pr<N>-body.md`), never a generic `pr-body.md`, because subagents share one scratchpad; read the file back and check it is this PR's before writing a body from it.

- **Name the file the finding landed on, in backticks**, the path the finding was reported against, not the file your reasoning is about. The gate reads it so a wrong finding cannot hold the bar at zero.
- **Name the round, first on the line** (`round 3`, `rounds 2, 4`, `rounds 3-5`), before the reasoning. The entry discounts its file only in the rounds it names; a line naming none discounts only the first round that flagged it; a new finding on the same file in a later round counts in full. If a later round re-posts the same wrong finding, add that round to the line.
- Only write an entry for a finding you pushed back on; a fixed finding gets a reply pointing at the commit.
- A repeat of a listed finding gets a one-line pointer to the entry, not a fresh argument.
- Before rejecting an accessibility or structure finding, check the design handoff's own tree; a finding the spec specified has to be accepted.
- **The person who owns the product can overrule a ratified spec; you cannot.** When a finding cites a contract the PR breaks, stop and put the evidence to the user as a scope decision: the contract, the clauses broken, the cost of accepting the breach. If they overrule it, the `## Settled` entry carries the contract file, the decision, the date, and the accepted cost.

## 7 · Convergence: watch the surface, not the round count

Below the stop a round is never refused for its number; late rounds still return genuine defects. What predicts "stop" is whether findings land on **new surface or the same one**.

- **Three-round rule.** When the same function or component draws findings in three consecutive rounds, the next action is a **scope decision, not another fix**: ask whether the code should exist. Repeated findings on one small surface mean it is over-built; delete it.
- **At four consecutive rounds the gate blocks the re-request and the merge**; the escape is a `## Settled` ruling naming the file (any mention releases the block). It fires only on a file the PR did not create: on a PR's own new component, repeat findings are the loop working.
- **After round 6, only a Critical or High finding in production code earns another round.** Everything else is fixed, pushed and merged.
- **After round 3, a finding that wants a NEW FILE becomes a follow-up** unless Crit/High in production code; so does a fix that ADDS BEHAVIOUR. The test: had this finding arrived at round 1, would it have been in scope? "No, but it is adjacent" means follow-up. Findings landing three rounds running on code the PR itself created is the signal; the gate says so in one line.
- **A finding about what something should MEAN is not a review finding.** Questions of meaning (what a legend decodes, what a mark says) go to the design queue as a ticket. A reviewer can say the code does not do what it claims, not what it ought to be.
- **Twelve rounds is a hard stop on requesting, not a reminder to check in**, and so is 4 hours open in review, whichever comes first. Scored rounds only; errored and stale reviews do not count. At the stop: fix anything outstanding that is Crit/High/Med in production code, merge, and report what you left and why. There is no round 13. This is no licence to merge past the bar: genuine Crit/High/Med findings still open at twelve are the thing to report, and mean the three-round rule should have fired earlier.

## 8 · The merge bar

- **A UI PR first needs its `## Design review` table and contact sheet.** Without them it does not meet the bar.
- No unresolved Critical/High/Medium findings, **and 2 CONSECUTIVE successful rounds**, a trailing streak, not a count. A finding between clean rounds proves they read code that has since changed.
- **§7's hard stop releases this bar**, because §7 forbids the only thing that could satisfy it, except on a destructive path, where the stop ends requesting but the merge waits for the user.
- **1 successful round suffices when returns are diminishing, and the GATE decides that, not you:** four or more rounds where the last three produced at most one finding between them.
- **1 round also suffices when the last fix touched only copy strings and their tests.** The gate recognises copy by its default copy-module path, `src/lib/copy/**`; strings kept elsewhere are scored as product code. The same holds for a round landing only on copy strings, on a code PR as well.
- **A PR the USER reviewed themselves needs one clean round, not two**: a `## Reviewed by <name>` heading in the PR body, parsed like `## Settled`; the gate prints who claimed it. **NEVER write this header yourself.** It is the user's input; it goes in only when the user added it or told you in conversation they reviewed the PR (say so in the entry). Never inherit it from a previous PR's body. It cannot be verified by the API, so the gate prints every use for audit: `node "${CLAUDE_PLUGIN_ROOT}/skills/pr-review/pr-gate.mjs" --audit-reviewed [owner/name]`. It never relaxes unresolved Crit/High/Med findings, and does not apply on a destructive path.
- **Except on a destructive path:** any diff issuing a DELETE, an overwrite or a wholesale replace of user data gets rounds until a clean round follows another clean round (superseded by the two Claude passes on a `## Copilot off` PR).
- Green CI is not a substitute for a round. No auto-merge flags, ever.
- **Red or pending CI blocks the merge, and the gate enforces it.** The bar is rounds AND a green head. Merge in its own command after the checks finish: a chained `gh pr checks --watch && gh pr merge` is judged before the wait runs, so the hook denies it while anything is pending.
- **When the bar is met, merge. Do not fix one more thing first.** An outstanding nit rides in the merge commit with no re-request, or becomes a follow-up; it never becomes another round.
- **Merge yourself once the bar and CI are green**, interactive sessions included. Do not park a green PR on a confirmation. A pending design ratification is not a blocker: record the amendment, merge, and put it in the close-out. Open questions go in the PR body.

## 9 · Doc-only PRs

Briefs, specs, plans, property tables, trackers, READMEs: anything with no runtime. The gate also counts a script edit whose every changed line is a comment, and a `plugin.json` or `package.json` change to the top-level `version` alone, as having none.

- **No Copilot round at all** (owner ruling, 2026-10-30). Read the diff yourself, fix what is wrong, and merge on green CI. The gate sets the bar to zero rounds and refuses the request.
- Read your own doc diff for factual errors in a spec, brief or property table (a missing enum case, an evidence table that does not support its claim, a brief describing a route wrongly); they cost a design round later. "Keep going" means keep FIXING, not keep REQUESTING; it never overrides §7's hard stop or §8's bar.
- Respond to a finding with an **inventory of the whole class**, not the one instance named. Draw the scope line in the PR body when findings land on staleness the PR did not create.
- **Bundle doc changes**: multiple in flight belong in one PR.
- Never open a spec-only or plan-only PR: spec, plan and code land together. For a large feature, have a subagent review the plan before implementation.

## 10 · PR structure

**No stacked PRs.** One PR at a time per feature line, based on `main`: open, review, merge, then cut the next off fresh `main`. Stacking looks like parallelism and is not: nothing merges until the root does, every rebase re-triggers review on every child, and a child's diff contains its parent's work. To drain an existing stack bottom-up, see reference.md.

- **Copilot refuses files past roughly 600-1000 lines**; treat ~600 lines as the per-file ceiling and split a large plan into an index plus per-PR sub-files.
- **Split on FILE COUNT, not line count.** Review surface is per-file. Over ~20 files, split (the gate also warns past ~800 runtime lines, excluding prose and generated files, as the weaker signal), and name the PR boundaries **in the plan**, before implementation starts. The natural cut is the plan's task groups (reference.md). If tasks cannot be cut, say so and get agreement before starting.

## 10b · The pre-open gate

Rules only stop wasted rounds; these stop the findings. Before opening, run these checks on your own work (detail in reference.md):

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
- After round 1, score it with `precheck.mjs score <pr> <predicted> <round1-total> --fixed=N --shipped=M --kind=K [note]`. `--fixed` is the pass's findings fixed before opening, `--shipped` counts demonstrated reach only, `--kind` is arithmetic, layout, modelling, wiring or prose. Scoring detail and the verdict thresholds are in reference.md.
- **Do not change `precheck-prompt.md` while the trial is open.** Bring the ledger's verdict to the user; the section stays a trial until it exists.

## 11 · Before opening at all

Do not open a PR, or request review, on content that has not passed your own first assessment. If something upstream must be fixed first (Design owes a token, a handoff has a known gap), surface it and hold. A spec or plan written during a brainstorm is an input to the next step: commit it on a branch and hand over the path; do not push or open a PR until asked.

## Red flags

| Thought                                                            | Reality                                                                               |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| "The header says changes recommended, so the round isn't clean"    | Only inline comments are findings. §4.                                                |
| "Copilot re-raised it, I'd better re-explain"                      | It's in `## Settled`. One-line pointer. §6.                                           |
| "Same finding again — one more fix should do it"                   | Third round on one surface = scope decision. §7.                                      |
| "The review came back fast, let me triage it"                      | Compare `commit_id` to `head.sha` first. §3.                                          |
| "Round 12, let me flag it and carry on"                            | 12 is a hard stop on requesting. Merge and report. §7.                                |
| "Fixed the nit, better re-request"                                 | Only a Crit/High/Med fix in production code earns a round. §5.                        |
| "Bar's met, but let me fix this one nit first"                     | Merge. The nit rides along or becomes a follow-up. §8.                                |
| "The probe has a real bug, that's a finding"                       | A probe cannot break production. Fix it, no new round. §4.                            |
| "Clean round on the delete path, we're done"                       | Destructive paths need clean-after-clean. §8.                                         |
| "I read the file, the class is swept"                              | Swept means a grep produced the claim. §5.                                            |
| "The test passes, the fix works"                                   | Push a commit that breaks the fix; CI must go red. §5.                                |
| "Bar's met but I'll check before merging"                          | Merge. Open questions go in the body. §8.                                             |
| "I'll stack the next slice on this branch"                         | No stacked PRs. §10.                                                                  |
| "A subagent can run the review cycle"                              | The wait exceeds its window. §2.                                                      |
| "79 rounds, it must be right"                                      | Review reads diffs. Load the routes — `feature-acceptance`.                           |
| "I know what round we're on"                                       | You do not, four hours in. Run `pr-gate.mjs`.                                         |
| "The finding is wrong, so the round doesn't count"                 | Only if you wrote it in `## Settled`, naming the file it landed on and the round. §6. |
| "That file is already in `## Settled`"                             | Only for the round the entry names. A new finding there counts. §6.                   |
| "It's one more behaviour, not a new file — the rule doesn't apply" | The rule is about scope, not files. Would it have been in scope at round 1? §7.       |
| "The gate is blocking me, I'll work around it"                     | It is quoting a rule you wrote. Read the reason; it names the section.                |
