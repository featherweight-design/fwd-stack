# epic-run reference

Gate procedures and the mid-run review in detail. SKILL.md links here; read a section when its gate fires.

## Why the gates exist

A forensic pass over several epics that passed a single design-review gate found a steady stream of post-merge UI/UX bugs. By class, largest first: state reachability and interaction/loading/flow (together about half), then visual fidelity, copy, cross-surface drift and responsive layout. The dominant half is one blind spot: a component-vs-mock comparison cannot see that the app never hands a correctly rendering component the right props. Canonical case: a shimmer loader structurally unreachable because a sibling PR's SSR seed made `isPending` false on first render. Gates 1-3 target that. Gate 5 came later because Gates 1-4 are per-PR and single-pass while the surviving bugs were cross-PR, lifecycle or premise-level (a "Join" button that looked inert on a server-rendered page; a nudge that never returned after leave then re-join because its dismissal was keyed by the group's id, not the membership's).

Each gate produces a committed artifact; an unenforced gate is what already failed. Gates 1, 5 and 6 are not per-PR: Gate 1 fires per API-to-UI seam, Gate 5 per journey (usually spanning three or four PRs), Gate 6 per trigger the spec names. Do not collapse Gate 5 into a PR checklist.

## Gate 1: state reachability, in full

For every state in the handoff's state-coverage table, answer: (1) **Type**: is the triggering field in the response type? (2) **Route**: does the route compute and assign it, or is it a `= null` stub? (3) **Runtime reachability**: given how the component is mounted, seeded and cached, can the triggering condition ever be true? Read the caller, the SSR/prefetch path and any parent supplying initial data. Mark each ✅ / ⚠️ (type present, route incomplete) / ❌ (not surfaced) / 🚫 (unreachable at runtime). Any ⚠️ ❌ 🚫 gets fixed before the UI build, or escalated. Commit as `docs/superpowers/state-coverage-<epic>.md`. It widens complete-and-ship's Step 2.5, which passes the shimmer case.

## Gate 2: forced-state runtime exercise

Start the dev server and exercise every state the handoff names by **forcing** it: throttle or go offline for loading, mock a 4xx/5xx for error, empty the fixture for empty, reload mid-flow for anything multi-step. Check mobile and desktop. Record what you forced and what you saw in the PR body. If a state cannot be forced locally, say so and validate on staging before merge. Catches: retry that does not retry, reload orphaning an in-flight OAuth, 403 from every entry point, missing loading states, post-paint pop-in.

## Gate 3: sibling duplicate sweep

For every array, constant or user-facing string the PR changed, grep the codebase for the **old** value; any surface still holding it is in scope. Also grep for locked-vocabulary violations (vocabulary in `.claude/fwd/copy-review.md`). Swept means a grep produced the claim.

## Gate 4: design-review, both halves

Pre-implementation: Agent 1 (enumerate) against the handoff only, committed to `docs/superpowers/design-tables/<epic>.md` and passed into every build subagent's prompt. Pre-PR: Agent 2 (verify) against that table plus the implementation, fix all gaps at once, Agent 3 (confirm) on the gap list, one more Agent 3 re-run on remaining items at most (four calls). Proceed only at 0 gaps or once the user accepts the listed remainder. Gate 4 mostly catches first-order gaps; Gates 1-3 and staging validation move the number.

## Gate 5: journey lifecycle

For every journey in the briefing's walk script, run four passes:

1. **Forward**: the happy path, realistic data.
2. **Reverse**: undo every commit the journey makes (unfollow, leave, dismiss, delete, cancel mid-flow). Does the UI return to a genuinely pre-action state, or a hollow one?
3. **Repeat**: do, undo, **redo**. For every dismissal, seen marker, one-time banner, tour or localStorage flag ask: what key is it stored under, and does that key die when the underlying thing dies?
4. **Resume**: reload mid-journey, and open the journey in a second session or device. Anything held only in component state shows up here.

**Mutation feedback sub-check.** For every mutation in the journey, time the gap between click and visible state change, with the network throttled (a fast local machine hides the bug). On a server-rendered page a mutation with no optimistic path looks broken. Clear an optimistic override on the **server value changing**, not on mutation success, which drops it before the new HTML lands and flashes the old state.

Record the four passes per journey in `docs/superpowers/journey-lifecycle-<epic>.md`. A journey that cannot be exercised locally is named and walked on staging before the epic is done.

## Gate 6: side-effect provenance

For a feature whose core is a record created by something else happening (notifications, digests, sync jobs, audit rows), the failure is silent: it never fires, fires twice, or fires for the wrong user. For every trigger the spec names, prove by running it: (1) **Fires**: perform the real upstream action and confirm the record exists. (2) **Fires once**: perform it twice, and concurrently if it can race; name the idempotency key or why none is needed. (3) **Right audience**: a second user's account confirms non-delivery. Then the lifecycle: what marks it read or handled, what happens on a second device, what happens to old records (retention, pruning), and the empty state before any trigger has fired. Commit as `docs/superpowers/side-effects-<epic>.md`. Skip with a line saying why when the feature creates no records in response to events.

## Gate 7: copy review, in full

Fires when `git diff main...HEAD --name-only` touches a file in the copy inventory named by `.claude/fwd/copy-review.md`, or a design handoff containing copy, or the PR adds a new inline user-visible string. Run `copy-review` over the diff, apply what it flags, re-run the quality gate before `gh pr create`. The binding names frozen areas; flag drift there to the user. A lint rule forbidding inline literals (such as `react/jsx-no-literals`) covers JSX text only: read the lint config itself, and read the diff for strings it cannot see (`toast.error(...)` arguments, strings in variables, on-screen error messages). Lint catches placement; this gate catches voice, length and vocabulary. Skip with a line saying why when the PR touches no copy.

## Risk shapes

- **Event-driven** (notifications, digests, syncs): risk is silent non-delivery, duplicates, wrong audience, unbounded growth. Gate 6 is the whole ballgame; Gate 5's repeat pass is second.
- **Content/data-driven** (an entity page fed by crawled or third-party data): risk is the long tail (missing images, absent fields, one-item and thousand-item collections, pathological strings). Gate 2 with deliberately ugly fixtures; real prod data is the only honest test.
- **Copy/IA-driven** (guides, onboarding, explainers): no runtime to break. Risk is redundancy, wrong vocabulary, a surface with no way back. Gate 7 on every PR; Defect Classes rows 6, 8 and 11 plus the cold-eyes review; skip Gate 2 for a static page.

## Mid-run cold-eyes review: steps

Triggered the moment the first complete user journey is reachable end-to-end (about half the UI PRs, never later than the second-to-last). It runs unattended; what a fresh reviewer catches is a function of arriving cold, without build context, seeing the whole vertical at once. A bug found at PR-3 costs one fix; the same bug after PR-8 costs six, because early mistakes get copied forward.

1. **Capture.** Add the epic's new routes to the project's UI-sweep route list (surface-adding PRs add theirs in the same PR) and run the sweep (`uiSweep` in `.claude/fwd.json`, or named in `.claude/fwd/epic-run.md`): a full-page screenshot per route x viewport, with overflow heuristics, for every auth state needed. Run it against **staging**, never production. If credentials are not placed, say so in the run report and fall back to local dev with Playwright screenshots; never silently skip.
2. **Critic subagent, context starved.** Give it only: the screenshot reel, the design handoff, the locked vocabulary (`.claude/fwd/copy-review.md`), the voice rules and the Recurring Defect Classes list. Not the plan, diffs, PR bodies or any rationale. Ask it to be picky about copy, affordance and IA: which strings repeat what the UI says, which control's purpose is unclear, where a surface has no way back, what a first-time user would misread. Ask for a ranked list with severities, and to say plainly when it has nothing.
3. **Triage and continue.** Fix everything valid in the current run. Before resuming, re-read the remaining PRs' scope against the triage list and amend the plan before building anything it invalidated.
4. **Notify, don't block.** Push-notify the review summary and screenshot path, then keep building; never schedule a wakeup to wait for a reply.
5. **Reserve the final PR slot for polish**, an unscoped PR where subjective calls land in one branch instead of four cleanup PRs. The pass converts a long morning list into a short one; it does not replace the user's eye.
