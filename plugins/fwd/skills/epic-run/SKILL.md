---
name: epic-run
description: Use when executing a large multi-PR feature epic end-to-end from a merged execution plan, when asked to "run" an epic autonomously through staging validation, or when resuming such a run in a fresh session.
---

# epic-run

**First, read the project's own rules.** If `.claude/fwd/epic-run.md` exists in the project, read it before anything else: it names the project's own tools and conventions for this skill, and its rules add to these and win where they conflict.

## Overview

Orchestrates an autonomous multi-PR feature build from a merged execution plan through staging-validated completion. The orchestrating session owns every review cycle end-to-end; subagents only build. Feature-specific facts live in a briefing file; this skill owns only the run mechanics. CLAUDE.md conventions apply in full. Gate procedures and the mid-run review steps are in [reference.md](reference.md).

**Use for** a feature epic with a merged execution plan, or a fresh session resuming one. **Not for** single-PR features (`complete-and-ship`), design-track work, or authoring the spec or plan.

## Pipeline position

epic-run is stage 3 of 3 and gates on the outputs of stages 1-2: (1) design briefs, handoffs and READINESS verdicts; (2) the eng spec and execution plan in one PR, merged at the `pr-review` bar. The plan names its PR boundaries (no stacked PRs; nothing over ~20 files or ~800 lines ships as one), and a UI plan carries the `feature-acceptance` route x viewport inventory, written before implementation starts.

## Preconditions gate: refuse to start if any is missing

1. Eng spec PR merged.
2. Execution plan PR merged at the `pr-review` bar, PR boundaries named.
3. UI in scope: design handoffs exist with READINESS verdicts.
4. Briefing file at `docs/superpowers/plans/YYYY-MM-DD-<epic>-briefing.md`.
5. **Three premise questions answered in writing** (plan or briefing), since all three escape every PR-stage gate:
   - **Launch gating**: when does this vertical become reachable, and what flips it? A plan whose last PR turns on a vertical needs this decided before PR-1.
   - **Off-happy-path homes**: for every new state the feature can put a user in, where does that user live in the IA?
   - **Journey walk script**: the numbered end-to-end script, written before the build. It drives Gate 5 and the mid-run capture, and is what the user walks after the run.

Missing briefing: interview the user with `briefing-template.md` (in this skill's directory), commit it via its own worktree and PR, then start. Missing premise answer: resolve it into the briefing, escalating product calls to the user. Missing anything else: stop and report; do not start "while the spec catches up."

## Kickoff (every run and every fresh-session resume)

1. Read in order: CLAUDE.md, the run's checkpoint note (the extension names it; the plan's `## Resume` section is the default), the briefing, the execution plan. A resumed session needs nothing from prior chat.
2. **Re-verify every claim in the briefing's Current State section** (env vars placed, external accounts live, feature flags) with real commands or MCP tools. A stale claim is a blocker to resolve or escalate, not a note.
3. Confirm the main repo dir is clean (`git status`); it stays clean for the whole run.

## Run loop: per PR, in execution-plan order

1. **Worktree:** `MAIN_REPO="$(git worktree list --porcelain | sed -n '1s/^worktree //p')"`, then `git -C "$MAIN_REPO" fetch origin && git -C "$MAIN_REPO" worktree add "$MAIN_REPO/.worktrees/<branch>" -b <branch> origin/main` (from `origin/main`, never the main checkout's local HEAD; or the location the extension names). Immediately copy each app's untracked local env file (e.g. `.env.local`) from the main checkout at the same relative path; never commit them.
2. **Build:** TDD (`superpowers:test-driven-development`), tests written with the code and run in CI only (pr-review §5). A subagent may implement, write tests and open the PR only; never put review-waiting in a subagent task. Tell each subagent to name scratch files after its PR or task (`pr<N>-body.md`), never a generic name.
3. **Run the gates scoped to this PR's shape (below) before `gh pr create`, and read the Recurring Defect Classes on every UI PR.** Pixel-perfect is the bar; mobile and desktop parity in the same PR; no UI PR is exempt, animation-only included.
4. **Pre-push, every push:** typecheck + lint (+ format check) in the worktree, then `git fetch origin && git rebase origin/main`. No tests or production build locally (pr-review §5). Plain push unless the rebase rewrote commits, then `--force-with-lease`.
5. **Review cycle (orchestrator-owned):** invoke `pr-review` and follow it. The orchestrator, never a subagent, owns the full cycle.
6. **Merge** yourself once pr-review's gate allows it (bar met, CI green), with the project's merge method and no auto-merge flags. Then verify the staging and prod deploy workflows actually ran; some merge paths (a merge through the API, for example) skip them, so dispatch manually if so.
7. **Bookkeeping**, on the same branch before merge: the project's release-note or changelog entry for user-facing PRs, any progress log the project keeps, and follow-ups collected as proposals under `backlog-audit`'s intake rule (no issue without the user's sign-off; unattended, proposals go into the run report's Proposed intake).
   - **An approved follow-up needing Design input also needs a row in `docs/superpowers/design-pipeline-status.md`**; `design-status` never queries issue labels. Judge by the fix: a missing affordance, a placement call or a new surface is design work even when it reads like a bug. Add the row on the branch then in flight, once the follow-up is filed.
   - **Infrastructure the PR depends on must be created, not just declared.** Hosting config (`render.yaml`, `vercel.json`) may be descriptive only. If a PR adds a cron, worker, queue, bucket or DB, provision it for real in both staging and prod before calling the PR done. Where you cannot, create what you can and carry the gap into the run report's infra table as `⚠️ declared only`. A cron that was never created logs nothing, errors nothing and never runs.
8. **Checkpoint** after EVERY merged PR: update the run's checkpoint note with exact state and next step, confirm the main repo dir is clean, compact.

Validate on the real staging URL after each deployed phase: CI green is not staging validation.

## Mid-run cold-eyes review: mandatory, never blocking

**Trigger:** the first complete user journey is reachable end-to-end (about half the UI PRs, never later than the second-to-last UI PR). Do not defer it to the end. It runs unattended: never wait on a human. Steps in reference.md: (1) capture the epic's routes on staging with the project's UI sweep, (2) dispatch a context-starved critic subagent (screenshots, handoff, locked vocabulary, voice rules, Defect Classes; never the plan, diffs, PR bodies or rationale), (3) fix everything valid in-run and amend the remaining PRs' scope in the plan before building them, (4) push-notify the summary and keep building, never schedule a wakeup for a reply, (5) reserve the final PR slot for polish. It shrinks the user's morning list; it does not empty it.

## The gates

Each gate produces a committed artifact recording **what was run and what came back**. "Verified ✅" with no evidence is an attestation, and attestations are what the old single gate was. Procedures: reference.md.

| Gate                        | Scope                          | Fires                                          |
| --------------------------- | ------------------------------ | ---------------------------------------------- |
| 1 State reachability        | API→UI seam                    | Before the UI PR's build starts                |
| 2 Forced-state runtime      | Per PR                         | Before `gh pr create`                          |
| 3 Sibling duplicate sweep   | Per PR                         | Before `gh pr create`                          |
| 4 design-review both halves | Per PR (Agent 1 pre-epic)      | Agent 1 before any code; Agents 2–3 pre-PR     |
| 5 Journey lifecycle         | **Per journey, across PRs**    | As soon as the journey is reachable end-to-end |
| 6 Side-effect provenance    | Per trigger the spec names     | Before `gh pr create` on the PR adding it      |
| 7 Copy review               | Per PR that adds or edits copy | Before `gh pr create`                          |

- **Gate 1** (artifact `docs/superpowers/state-coverage-<epic>.md`): for every state in the handoff's coverage table, check type, route and runtime reachability (given how the component is mounted, seeded and cached, can the trigger ever be true?). Any ⚠️ ❌ 🚫 is fixed before the UI build.
- **Gate 2:** start the dev server and _force_ every state the handoff names (loading, error, empty, reload mid-flow) at mobile and desktop widths; record what you forced and saw in the PR body. A state that cannot be forced locally is validated on staging before merge.
- **Gate 3:** grep the codebase for the _old_ value of every array, constant or string the PR changed, and for locked-vocabulary violations; any surface still holding it is in scope.
- **Gate 4:** design-review Agent 1 before any code (table committed to `docs/superpowers/design-tables/<epic>.md` and passed into every build subagent), Agents 2-3 before the PR, at most four calls; proceed at 0 gaps or when the user accepts the remainder.
- **Gate 5** (artifact `docs/superpowers/journey-lifecycle-<epic>.md`): for each journey in the walk script run forward, reverse, repeat (do, undo, redo; what key does each dismissal use, and does it die with its subject?) and resume (reload mid-journey, second session), plus the mutation-feedback check under a throttled network. Unexercisable journeys are walked on staging before done.
- **Gate 6** (artifact `docs/superpowers/side-effects-<epic>.md`): for every trigger the spec names, prove by running it that it fires, fires once, and fires for exactly the right audience (a second account confirms non-delivery), then the lifecycle and the empty state. Skip, with a line why, when no records are created from events.
- **Gate 7:** run `copy-review` over the diff before `gh pr create`; skip, with a line why, when no copy is touched. A lint rule against inline literals covers JSX text only: read the diff for the rest.

**"Blocked" and "not applicable" are claims about the repo and must be checked against it.** Grep for the capability before claiming its absence; reporting a gate blocked when the tooling exists retires it silently.

**Every bug the walk finds ships with a regression test.** For route- or auth-shaped bugs, add the route to the project's UI-sweep route list instead of a bespoke test, and assert the mapping, not the existence.

### Which gates fire when

| PR shape                                         | Gates                                                                  |
| ------------------------------------------------ | ---------------------------------------------------------------------- |
| Migration / schema only                          | none (plus normal review bar)                                          |
| API / route only                                 | 6 if it creates records; 1 runs _after_ it, before the dependent UI PR |
| UI PR                                            | 2, 3, 4, plus the Defect Classes list                                  |
| Any PR adding or editing customer-facing strings | 7, whatever else applies                                               |
| First PR making a journey reachable end-to-end   | 5, and trigger the mid-run cold-eyes review                            |
| Any PR touching a launch flag or route matcher   | Defect Classes row 6 (auth matrix), always                             |

Read the Defect Classes on every UI PR even when the expensive gates are scoped out. **Name the epic's risk shape in the briefing and over-invest there** (event-driven, content/data-driven, copy/IA-driven; reference.md).

## Recurring Defect Classes: check every UI PR against this list

Each row shipped past a passing gate. Most are one grep or one question per PR. When a PR trips a row, sweep the class across the codebase rather than patching the instance. Add a row when a walk finds a bug no row would have caught.

1. A disabled or blocked control renders **what it is waiting on**, wired with `aria-describedby`.
2. No interactive element nested inside another (`<button>` inside `<Link>`); `pointer-events: none` hides the trap rather than fixing it.
3. Any `position: fixed` overlay **portals to `document.body`**; a transformed or clipping ancestor re-anchors `fixed`. Fix it in the shell component, not at one call site.
4. A shared component reachable from N entry points **keys its copy off the entry**, not a default. Add the entry prop before the second call site exists.
5. Gate at the **earliest** point the user could learn, not at submit; gate inside the modal or flow so it covers all call sites.
6. **Auth-matrix sweep:** every newly linked route crossed with every auth state and launch-flag state, checked against the middleware matchers. A route linked but absent from both public matchers is a dead end.
7. A state reached **by transition** is not the same as one rendered fresh: React writes only changed props, so a shorthand can strip a longhand set elsewhere. Prefer longhands in anything that animates or toggles; verify by flipping state.
8. Each new user-facing string must **say something the adjacent UI does not already say**; redundant reassurance reads as insecurity.
9. The same gesture is the same affordance at **every breakpoint**; a desktop-only label reframes the icon as mobile shorthand.
10. DOM order is **mobile** order: put a sidebar or rail first in the DOM and pin desktop placement (`lg:col-start-*` / `lg:row-start-*`).
11. Do not name a tier or entitlement on a surface only entitled users can reach.
12. A mutation on a server-rendered page needs an optimistic path, cleared on the **server value changing**, not on mutation success.
13. Dismissals, "seen" flags and one-time banners are keyed by an id that **dies when the thing dies**; use a new storage key when the stored shape changes, since a strict type guard rejects the whole store on one stale value.

## Escalation classes

- **Hard pause**, stop and ask: (a) any PRODUCTION database migration, (b) anything the briefing lists as a hard pause, (c) ambiguity the specs and briefing do not resolve; ask, never invent.
- **Notify-and-proceed**, for actions the briefing lists here: validate the identical flow in safe mode (test mode, staging), capture concrete evidence, post the summary, then execute and continue. The evidence trail is the control.
- **Secrets:** never ask the user to paste secrets in chat. List new env vars in the PR body (name, purpose, creation instructions) and pause the dependent step until placed.
- Everything else reversible and in scope: decide and proceed.

## Red flags: stop, you are about to repeat a documented failure

| Thought                                                      | Reality                                                                      |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| "I'll just edit this one file in the main repo dir"          | Every file change happens in a worktree.                                     |
| "Subagent can handle the review round-trip"                  | The wait exceeds its window. The orchestrator owns reviews (`pr-review` §2). |
| "All the PRs merged green, the feature is done"              | Green PRs leave gaps at the seams. Walk the inventory.                       |
| "The component matches the mock, ship it"                    | Ask whether the app ever hands it those props (Gate 1).                      |
| "I rendered the happy path, states look fine"                | Gate 2 means forcing loading, error, empty and reload.                       |
| "The journey works"                                          | Forward only? Gate 5 is forward, reverse, repeat and resume.                 |
| "Merged — deploys are automatic"                             | Verify the workflows ran.                                                    |
| "I'll update the checkpoint note at the end of the run"      | After EVERY merged PR; sessions die without warning.                         |
| "The briefing says the env var is placed"                    | Re-verify at kickoff.                                                        |
| "I'll review the whole vertical at the end"                  | Cold-eyes review at the halfway point.                                       |
| "I'll pause here for the user to walk it"                    | The run is unattended by design. Notify and keep building.                   |
| "I'll give the critic subagent the plan for context"         | That context blinds it. Screenshots, handoff, vocabulary, voice rules only.  |
| "The plan doesn't mention a launch gate, so there isn't one" | Absence is not a decision. Ask before PR-1.                                  |
| "That state has no home, but it's out of scope"              | Escalate; it is a product call.                                              |
| "I can't run that gate here"                                 | Grep for the capability first.                                               |
| "design-review passed"                                       | Both halves, with the table committed and fed to subagents?                  |

## Done means

All plan phases complete through staging validation; every PR merged at the full bar; every gate that fires for this epic passed with its committed artifact and evidence, scoped as above; the Defect Classes read on every UI PR; the mid-run cold-eyes review ran and its triage list is closed (blockers fixed in-run, polish in the reserved final slot); the briefing's "Done means" items satisfied; the launch gate in the state the briefing specifies; launch-day and runbook steps documented if the briefing calls for them.

**Close-out runs `feature-acceptance` before the report:** every row of the plan's route x viewport inventory walked in a real browser against the brief, the contact sheet produced, import-equality and marker checks passing. A feature line whose PRs all merged green is unfinished until that walk happens.

**The final report is not free-form.** Invoke the `feature-run-report` skill: it emails the run report and pings the phone. Divergence from its shape loses signal.
