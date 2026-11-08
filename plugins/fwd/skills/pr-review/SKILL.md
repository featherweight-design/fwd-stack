---
name: pr-review
description: Use when running a GitHub Copilot review cycle on a pull request — requesting the review, waiting for it, deciding whether a round counts, triaging findings, pushing back, and deciding when the merge bar is met. Also governs PR structure — size, splitting, and the ban on stacked PRs. Single source of truth across every repository.
---

# pr-review

**First, read the project's own rules.** If `.claude/fwd/pr-review.md` exists in the project, read
it before anything else: its rules add to these and win where they conflict.

## Owner ruling, 2026-10-30, amended 2026-11-08: Claude reviews, Copilot is off. This overrides §1, §5, §7 and §8 below

From 2026-11-08 no PR requests a Copilot review, risky ones included. Claude reviews every code
PR, and risky PRs get a second, targeted pass: the risk checklist, aimed at the ten classes that
Copilot caught and Claude's review missed (the evidence is under the change freeze below).

| PR kind                                                                                                                                    | Review                                                                                                                                                                                          | Merge bar                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **Risky code**: destructive diff, migrations/schema, DB layer, auth/session/proxy, payments/credits/billing/webhooks, API routes, security | **Claude review, two passes.** `/code-review medium` on the diff, then the risk checklist pass. Fix every valid finding. No Copilot.                                                            | `## Copilot off` + `## Claude review` recording both passes + green CI |
| **Other code**                                                                                                                             | **Claude review.** Dispatch the `caveman:cavecrew-reviewer` agent on the PR diff with the addendum below, fix what it finds, and record it in the PR body under `## Claude review`. No Copilot. | `## Claude review` + green CI                                          |
| **Doc, design, test, probe, script or copy-only**                                                                                          | None. Read your own diff.                                                                                                                                                                       | Green CI                                                               |

- The gate classifies the PR (`copilot scope` line) and enforces this table. It refuses any Copilot
  request on a non-risky PR. On a risky PR, never request one: write `## Copilot off` in the body.
  **The `## Copilot off` door** (plugin 0.1.19): with that heading, a risky PR meets its bar when
  `## Claude review` is a real record that names `/code-review` and holds a `Checklist pass:` line
  that is itself a record (`Checklist pass: pending` is not). The gate prints a `copilot off` line on
  every PR that declares it, says what is missing when the door stays shut, and refuses every
  Copilot request while the heading is there. A risky PR without the heading is still held to one
  Copilot round; that path stays only for the rollback trigger below. Destructive diffs take this
  door too, as they took the budget stop: Claude's two passes are their review.
- **`## Risk: not risky`** (Hugh, 2026-10-30): risk is what the diff changes, not where it sits. A path-risky PR that only reads or displays (copy, UI, tests) gets this heading and one line of reason; the gate then wants a Claude review only. When unsure, record the call there and default to a Claude review.
  Ignored for destructive diffs, migrations/schema, API/cron routes, auth/session/middleware/proxy and webhooks (`HARD_RISKY`, `risk-override.mjs`). The `risk override` line prints each use for the month report.
- **Budget stop.** The `## Copilot budget stop` door is still in the gate, but with Copilot off it
  has no use. It is not a substitute for `## Copilot off`.
- **Which Claude reviewer.**
  - **Risky PRs: `/code-review medium`, then the risk checklist pass.** Dispatch a general-purpose
    subagent with `${CLAUDE_PLUGIN_ROOT}/skills/pr-review/risk-checklist-prompt.md` as its prompt,
    after `/code-review medium` has run and its fixes are pushed. The rules are §10b's for the
    precheck pass: not a fork, the branch only, no plans or handoffs, the same subagent grant, and
    verify every finding before acting on it. It is a separate pass, not an argument to
    `/code-review`, so it runs the same in every repository and is scored on its own. It reports
    Lows on comments, names, probes and selectors (its checks 8 and 9): fix those too.
  - **Other code: `caveman:cavecrew-reviewer`.** It is a read-only subagent that returns one line
    per finding, so only the findings come back into the session. Add this to its dispatch prompt:

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

  - **House rules live in `.claude/fwd/review-rules.md`** in each project. Both passes read it.
  - Don't use a GitHub-side Claude Action; it bills API usage per run.
- **`## Claude review` records:** the reviewer used (`cavecrew-reviewer` or `/code-review <level>`), the
  number of findings by severity, and what was fixed or declined. One short paragraph. On a risky
  PR it records both passes, the checklist on its own line:
  `Checklist pass: <n> findings (C/H/M/L), <what was fixed or declined>`, or
  `Checklist pass: no findings.`
  The gate rejects a section that is empty or a placeholder (pending, TBD, todo, n/a, a comment).
- **A/B v2 line (risky PRs).** Add one line to `## Claude review`:
  `A/B v2: Copilot off, Claude <n> (C/H/M/L), checklist-only real <n> [checks], code-review-only real <n>`.
  A finding is "real" if you fixed it. The bracketed check numbers (1 to 10) show which checks
  earn their keep; the month report adds these lines up. The older `A/B:` lines stay as history.
- **Measured to 2026-11-30, then re-ruled.** Escapes are tracked four ways:
  1. **Fix PRs name the source.** When a fix PR repairs a defect an earlier merged PR introduced,
     its body names that PR under `## Escaped from #N`.
  2. **A weekly sweep.** Each Friday, list the PRs merged that week with `fix`, `revert` or
     `hotfix` in the title that touch a file a risky PR changed in the 14 days before, and label
     each one an escape or not. This catches the escapes nobody labelled.
  3. **An audit sample.** Every 5th merged risky PR gets a fresh-session `/code-review high` on its
     merged diff the next day. A real finding counts as a latent escape. Kept through December,
     then dropped if it has found nothing real.
  4. **CI on main and runtime errors.** A red main after a risky merge, or a new error class in
     the runtime logs for a touched route, is checked against the risky PRs.
- **Rollback trigger.** Any Critical or High escape from a risky PR, or more than 1 Medium escape
  per 15 risky PRs, ends Claude-only review on risky PRs: stop, report it to the owner, and give
  risky PRs one Copilot round again until the policy is re-ruled. Below that line, Copilot stays
  off.
- The rest of this document still governs how to read and triage a review: staleness, findings,
  sweeping a class, `## Settled`, PR structure. Where it says "round", read a review pass.

Canonical policy for GitHub Copilot review cycles and PR structure.

**This skill governs whether the code was read. It does not, and cannot, tell you
whether the feature is actually there** — a review reads a diff, and a route that
never got the component, a phone layout that diverged from desktop, and a surface
that reimplemented what another route already had are all invisible in one. Those
are `feature-acceptance`'s job, and no number of review rounds substitutes for it.
Invoke both. Every
repository, every run. Nothing else restates this — the user's own `CLAUDE.md` holds
only the hard gates and a pointer here; project `CLAUDE.md` / `AGENTS.md` and
other skills point here rather than copy.

## The gate runs this; you do not have to remember it

`node "${CLAUDE_PLUGIN_ROOT}/skills/pr-review/pr-gate.mjs" <pr> [--action merge|rerequest]`

It reads the PR and prints the state every rule below depends on — the round
count, what each round's findings landed on, whether the last review saw the
current head, how many successful rounds are trailing, whether one surface has
drawn findings three rounds running, and which files appeared after round 3.
With `--action` it judges that action and exits non-zero when a rule forbids it.

**A PreToolUse hook runs it before `gh pr merge` and before a review
re-request, and denies the call when it exits non-zero.** The hook reads the command
line itself, and **fails closed**: a command that mentions a merge it cannot attribute to a PR
(a wrapper, a substitution, a heredoc, an unknown flag, a merge of the current branch) is
denied with the plain form to use, `gh pr merge <number> [--repo owner/name]`. A repository the
command names (`--repo`, `-R`, an API path) always decides. One that names none is resolved in the
directory a plain `cd <path>` takes it to, and outside any checkout it is denied. That is deliberate.
The hook runs the newest installed gate (`~/.claude/fwd`, when it links into the plugin cache), so
a gate fix reaches running sessions without `/reload-plugins`; a session loaded before 0.1.16 needs
one reload to pick up that delegation. A denial names the gate path that ran.
Every rule here was written after a real cost, and then the person who wrote
them broke three of them in a single PR — merged one eight rounds after its bar
was met, patched one surface for three consecutive rounds instead of deciding,
and added new files at round four. None of that was disagreement. It was not
knowing, in the moment, what round it was.

Prose read once at the start of a turn cannot answer that four hours later.
A command can. Run it whenever you are about to act on a PR, and read what it
says rather than recalling what you think the state is.

## Change freeze — in effect from 2026-09-18

**Do not add or tune a rule in this document without new measured evidence.**
Six rules changed on 2026-09-18 alone, several on a single report each. The
results are real — rounds per PR fell 8.3 to 3.0, and cost per PR fell with them
across 30 PRs — and that is the reason to stop: the tuning rate has outrun the
evidence rate, and n=1 with a clear causal story is good evidence for a fix and
poor evidence for a threshold.

Three specific cautions, each earned:

- **This gate is now big enough to be its own risk.** Three defects were found in
  it in one day: `truncate` matching a Tailwind class, `productIsTooling`
  satisfied vacuously by a docs-only PR, and §7's hard stop making a PR that had
  never been reviewed permanently unmergeable — the only move that cleared it was
  the one it forbade. Fix defects in the gate freely. Adding rules is what is
  frozen.
- **Eight doors now reach a lowered bar** — doc-only, copy-only, human-reviewed,
  diminishing returns, soft-fixed, §7's hard stop, `## Settled`, `## Doc-sync`.
  Audited over the 60 PRs merged after 2026-09-16 (a PR can pass through more than one, so these
  overlap): `## Settled` 48%, plain two-round bar 38%, doc-only 12%, human-reviewed 8%, and a sample of the
  `## Settled` sections found substantive evidenced declines rather than
  shortcuts. No abuse. But a ninth door needs to justify itself against that
  count, not only against its own case.
- **Agreement between concurrent agents is not independent evidence.** Same app,
  same day, same model. Weigh it as one observation.

Re-audit before changing anything: rounds per PR, cost per PR, and the door
distribution above.

**The 2026-11-08 change met that bar, and this is its evidence.** Over the risky PRs that ran both
reviewers from 2026-10-30, Copilot found 33 real defects (fixed by the author) that Claude's review
did not, across 15 PRs: 3 High, 15 Medium, 15 Low. They fall into ten classes, one check each in
`risk-checklist-prompt.md`: check-then-act races (4), old state meeting new code (5), a retirement
or filter not swept to its siblings (5), a change breaking an existing test (3), new behaviour no
test pins (3), UI state not following its inputs (3), scripts, workflows and probes out of order
(4), a comment, name or claim the code does not match (4), parsing that accepts impossible input
(1) and a repository house rule only Copilot had been told (1). 22 of the 33 sat outside the diff:
in old data, a sibling file, a test mocking the changed module, or the workflow calling a script.
Do not add a check to that prompt, or tune one, without new measured evidence of the same kind: a
class that escapes more than once.

## Why this exists

Measured across two feature runs on 2026-09-11/12: 20 PRs, **204 Copilot
rounds**, average 10.2 per PR, worst 32 rounds against 35 inline comments. Most
of that gap was not review doing its job. It was four mechanical failures — a
stale review triaged as if it were fresh, a summary header treated as a gate, the
same over-built surface fixed five times instead of deleted once, and a settled
push-back re-argued from scratch thirteen times.

Review itself pays. In the same runs it caught a 62px nav rail that every column
calculation in a design package had ignored, `ø` surviving NFD normalisation so a
diacritic-folding search for "Soren" would never match "Søren", iOS Safari zooming on sub-16px
inputs in a layout whose whole arithmetic depended on it not doing that, a
"fixed height" row that excluded its own child's margin, and a test asserting a
`requestAnimationFrame` callback without flushing one — which passed with the fix
removed. Review is best at arithmetic, platform quirks, and tests that measure
nothing: precisely what a confident author skips checking.

So the goal is not fewer rounds. It is rounds that each read new code.

**Judge every rule below by whether it removes a ROUND, not by whether it makes
a round cheaper.** Latency is the entire cost: one PR's six real reviews landed
8–18 minutes apart — roughly 75 minutes of pure waiting on code that took twenty
minutes to write. Triage time is rounding error beside that. This is what makes
§5's class-sweep rule the highest-value rule in the document: an unswept sibling
does not cost you the minute it takes to fix, it costs you a whole round.

## 1 · Requesting a review

Copilot does **not** auto-review, and a push alone triggers nothing. Request on
open, and after a fix push only when §5 says the fix earns a round and the bar
(§8) is not yet met. The gate judges both: `--action rerequest`.

```bash
gh api -X POST repos/OWNER/REPO/pulls/N/requested_reviewers --input - <<'JSON'
{"reviewers":["copilot-pull-request-reviewer[bot]"]}
JSON
```

- Use `--input -`. Form-encoded `-f` URL-encodes the `[bot]` brackets and 422s.
- The bare display name `"Copilot"` returns 200 and silently attaches nothing on
  re-requests. Always the full `copilot-pull-request-reviewer[bot]` login.
- **A 200 is not proof.** REST omits bots from `requested_reviewers`, so an empty
  array proves nothing either way. Verify on the timeline — one
  `review_requested` event per round:

```bash
# --paginate prints one JSON array per page; jq -s joins them before counting.
gh api repos/OWNER/REPO/issues/N/timeline --paginate \
  | jq -s '[.[][]|select(.event=="review_requested")]|length'
```

- If a project ships a helper script for this, use it; it should fall through to
  a confirmation poll rather than failing outright on an empty response.
- **The POST response is a hint, never a verdict — in both directions.** It can
  report failure while Copilot reviews the PR normally: the body is a snapshot
  that races Copilot's own consumption of the request. Observed with four
  consecutive "failed" attaches against three genuine submitted reviews. An
  immediate re-check proves nothing either — one review landed at ~90s after
  both the request list and the reviews list read empty at ~20s. Give it **two
  minutes** before treating absence as absence. Re-POSTing in the gap is harmless.
- **A PR can exhaust Copilot after roughly nine rounds.** The attach then stops
  registering entirely: nothing queues, nothing lands, longer backoffs do not
  help. Tell it apart from the false-negative by escalating the backoff — if 280s
  and 900s fail identically, it is not throttle timing. After three failed
  attaches on a PR that has already had many successful rounds, stop and hand it
  to the user to attach via the UI reviewers gear. Do not keep polling, and do
  not merge on a self-invented fallback. Also ask whether the PR is simply done:
  nine rounds usually means the answer is yes.
- **A wedged run is a third case, and you restart it yourself.** A run that
  started and never finished swallows every later request: the timeline's
  `review_requested` count stops rising however often you POST, and
  `DELETE requested_reviewers` does not remove the bot. Restart it with
  `node <skill dir>/restart-review.mjs <pr> --repo owner/name`. The script runs
  the gate's re-request check first and changes nothing if the gate refuses.
  Otherwise it cancels the request, toggles the PR to draft and back (which ends
  the run; a PR that is already a draft is left alone, so its run may survive),
  re-attaches Copilot along with any people and teams who were requested, and
  confirms on Copilot's timeline events. It exits 0 only when Copilot's attach
  is confirmed and everything was restored. Otherwise it prints `NOT RESTORED:`
  lines for what you must fix by hand. When the attach itself is not confirmed,
  hand the PR to the user.
- GraphQL `requestReviews` used to be the fallback. As of 2026-09-07 it 404s
  (`Could not resolve to User node…`, with the correct `botIds:` field) while
  plain REST works. **The hook denies it:** the mutation names the PR by node id,
  which the gate cannot attribute, so it fails closed. If REST and the timeline
  both show nothing, hand the attach to the user (the UI reviewers gear). The
  mutation's shape is kept here for a user running it by hand:

```bash
gh api graphql -f query='mutation{requestReviews(input:{
  pullRequestId:"<PR_NODE_ID>", botIds:["BOT_kgDOCnlnWA"], union:true}){
  pullRequest{reviewRequests(first:10){nodes{requestedReviewer{
  __typename ... on Bot{login}}}}}}}'
```

The argument is `botIds:`, never `userIds:` — a `BOT_…` id in `userIds` fails
with a message that reads like a stale node ID. `BOT_kgDOC9w8XQ` (nominally the
coding agent) has also resolved to the reviewer, so read the mutation's own
`reviewRequests` back rather than trusting the id you sent. Get a live id from
any prior bot review: `gh api repos/O/R/pulls/N/reviews --jq '[.[]|select(.user.type=="Bot")][0].user.node_id'`.

**Confirm the push actually landed before counting the round.** A chained
`git rebase && git push && gh api …` short-circuits silently — one agent's rebase
hit a real conflict with a concurrent agent, the chain stopped, and the "pushed
and re-requested" line printed anyway over a detached HEAD. Two rounds of
wall-clock went to reviewing code that was never uploaded. Same shape as the
"a 200 is not proof" rule above:

```bash
[ "$(gh api repos/OWNER/REPO/pulls/N --jq .head.sha)" = "$(git rev-parse HEAD)" ] \
  || echo "NOT PUSHED"
```

One call, and it catches a failed push, a failed rebase and a rejected
`--force-with-lease` alike. The gate runs this too, whenever it is invoked from a
checkout of the PR's own head branch.

**Two agents on one repository interfere.** Concurrent requests coincided with a
run of three errored reviews, and concurrent work on one test file produced the
rebase conflict above. Neither is proven causal, but when reviews start erroring
on a healthy PR, check whether another agent has a request in flight on the same
repository before escalating backoffs — and expect rebase conflicts rather than
chaining past them.

## 2 · Waiting

- **Use the shipped watcher, armed once when the PR opens:**
  `Monitor({ command: 'node "${CLAUDE_PLUGIN_ROOT}/skills/pr-review/pr-watch.mjs" <pr>', description: 'PR <pr> reviews, CI and merge', timeout_ms: 1800000 })`.
  It prints one line for every new review (fresh, STALE or errored), for each head's CI, and for the merge,
  and it keeps running across re-requests. A hand-rolled `until the count rises; exit` loop wakes on round 1
  and then nothing is watching: round 2 lands in silence, and silence reads as waiting (it happened on four PRs
  in one week). When it prints `TIMED OUT`, re-arm it. The rules below are what it implements.
- If you hand-roll a poll instead, every ~240–270s is enough (the shipped watcher polls every 45s
  because it costs nothing between lines). Count reviews whose `.user.type == "Bot"` — filtering on
  the bare login `"Copilot"` matches nothing and times out silently.
- Poll the **count** above where it started. An emptied `reviewRequests` does not
  mean a new review landed; the previous round's review satisfies that check.
- Your own replies to review comments create review records. Filter or your
  watcher announces a round that is your own pushback.
- If nothing lands after ~2 cycles, re-verify the request registered rather than
  polling on.
- **Subagents cannot run this cycle.** The multi-minute wait exceeds their
  window. The orchestrating session owns request → wait → triage → fix →
  re-request → merge. A subagent may open the PR and fire the first request, then
  return.

## 3 · Before triaging: is this review stale?

**Required, every round, before reading a single finding.**

```bash
# The REF, not the PR API: `pulls/N` lags by seconds, and that lag reports a
# review as having seen the current head when an amend moved it moments earlier
# — handing you a stale round to triage as fresh. Two agents hit it in one day,
# from both directions.
head=$(git ls-remote origin refs/heads/BRANCH | cut -f1)
seen=$(gh api repos/OWNER/REPO/pulls/N/reviews --paginate \
  | jq -rs '[.[][]|select(.user.type=="Bot")][-1].commit_id')
[ "$head" = "$seen" ] || echo "STALE — discard and re-request"
```

If they differ, the review never saw your last push. **Discard it unread and
re-request.** Do not triage it, do not answer it, and do not write "declined,
already fixed" replies to it.

Roughly a third of one run's rounds were this, each one costing a full
read-write-respond cycle to answer a review of code that no longer existed. It is
the single largest avoidable cost in the loop.

## 4 · What counts as a finding

**Only inline comments.** Read the full review body, never the header.

- The summary verdict — 🟢 _Approval recommended_, 🟡 _Changes recommended_,
  🔵 _Needs a closer look_ — is **never a gate**, in either direction. It
  routinely restates threads you have already fixed, because Copilot cannot
  resolve its own threads. One PR ran ten more rounds after a 🟢; another ran
  eighteen rounds against eight comments, ten of those rounds producing no new
  comment at all while the header insisted findings remained.
- 🔵 "warrants final human review" is an advisory on a broad diff, not a finding.
- **Suppressed comments are findings.** A review headed "generated no new
  comments" frequently carries them inside
  `<details><summary>Suppressed comments (N)</summary>`. They live in the review
  **body only** — the inline-comments API never returns them, so a round judged
  from `pulls/N/comments` reads clean while holding real bugs. Dump full bodies
  before judging a round:

```bash
gh api repos/OWNER/REPO/pulls/N/reviews --paginate \
  --jq '.[]|select(.user.type=="Bot")|.body'
```

- **Errored reviews count for nothing, in either direction.** "Copilot
  encountered an error…" is not a round: it produces no findings, so it proves
  nothing about the PR and must not break a clean streak. The gate drops them.

  **Retry immediately, then once at 120s, then hand it to the user.** Do NOT
  apply the escalating backoff in §1 — that is for an attach that never
  registers, a different failure with a different cause. Treating an error as
  throttling cost one agent 25 minutes of 300s and 900s waits for a service
  outage that no amount of waiting fixes.

**A finding in a test, probe, fixture, or script is Low by definition** — unless
it makes the test vacuous, and even then it is fixed without earning another
round. None of it can break production. On one PR, 9 of 24 findings were on the
browser probe and its test; on another, 5 of 12. Every round they cost bought
nothing.

**"Cannot break production" is a rule about rounds, not about value.** The
severity floor decides whether another review is owed — nothing more. One round-1
probe finding was a latent false failure that would have fired on any list holding
an item with no image; it was worth more than most Mediums. Fix these properly, sweep
their class, mutation-check them in CI. Just do not buy a round with them.

A **successful round** is one with no new inline comment and no new suppressed
comment, or only Low/Nit ones — regardless of the header.

**A round that raised nothing inline and did not say `Changes recommended` is
successful too.** 🔵 _Needs a closer look_ with two suppressed comments is a
reviewer describing the diff, not blocking it: everything it had, it chose to
suppress. Read the findings and fix what is valid — that never changes — but do
not spend a round proving you did. `Changes recommended` always counts, whatever
it landed on, because it is the one verdict claiming something must change
before merge.

This does not reinstate the header as a gate. A 🟢 over real unresolved findings
is why that rule exists and it still holds in that direction: **the header can
lower a round's weight, never raise it**, and it never excuses reading the
findings.

**Findings on a design handoff are not findings** — where a project keeps design
handoffs under `design/` owned by a separate design process (as the gate assumes).
There, a handoff is audited for readiness and is a record of what that process
decided. A code reviewer's opinion on it carries no weight
in a round, and acting on one edits somebody else's document. Fix the CODE the
handoff describes and leave the handoff to its own process; if one genuinely
contradicts a shipped ruling, that is an errata note for the next design round,
not a PR comment to implement.

**Use the companion clause, don't just refuse.** One PR drew 12 suppressed
comments, 9 of them on `design/`; three named genuine contradictions between the
handoff and the audit. Those go two places: the errata table in the readiness
doc, and a `## Settled` entry naming the file — which is what makes the gate
discount them rather than counting them against the round.

## 5 · Triage

| Severity                                                  | Action                                               |
| --------------------------------------------------------- | ---------------------------------------------------- |
| Critical / High — correctness, security, broken contracts | Fix → gate → push → re-request                       |
| Medium — naming, missing validation, minor logic          | Fix → gate → push → re-request                       |
| Low / Nit                                                 | Apply if valid and cheap; does not reset the counter |

**"Gate" before a push means typecheck and lint, never tests.** The local gate before every push
is typecheck + lint (plus a format check where the project has one), then
`git fetch origin && git rebase origin/main`. No tests of any kind run locally: not the full
suite, not targeted tests, not a local mutation check, and no local production or stub build.
CI is the only test gate, and a PR merges only on green CI, which the merge gate already enforces
(red or pending CI blocks it, §8). The reason, stated once: four lanes each running a
~12,900-test suite locally pushed machine load past 150, and gates timed out. Every other skill
that names a pre-push gate means this one.

The CI shape this assumes: related or selected tests on PRs and pushes to main, and the full suite
nightly on main (on a schedule and by `workflow_dispatch`) as the safety net for that selection.
The full suite also runs on lockfile, config, CI or dependency changes, or when a PR carries a
`ci:full` label. A red nightly goes to the orchestrator.

- **Fix every valid comment, including nits.** Never offer a "fix the bug, defer
  the nits" path. Deferrals need explicit user approval before the PR opens.
- **Doc-sync findings don't reset the counter — and the gate now honours that.**
  It cannot classify a finding itself, so name the paths in a `## Doc-sync`
  section of the PR body, exactly as `## Settled` names declined ones. Without
  that marker the gate scores the round substantive and the prose here is a dead
  letter: one PR spent two extra rounds because round 4's only finding was a
  parameter named `retryable` while its caller passed `resumable`. PR-description↔code mismatches,
  stale comments, plan-doc references, migration-number drift — fix them
  same-round, they're cheap, but the round still counts as successful. Any
  finding revealing an actual behaviour, type or logic issue is not doc-sync and
  resets as usual. An entry is scoped like a `## Settled` one: one line per
  finding, naming its round, and it covers that round only. A later finding on
  the same file counts in full.
- **A push does not oblige a re-request.** This is the gate that matters, because
  the re-request is the expensive act — it costs a round, and that round finds a
  new nit, and the loop runs. **Re-request only after fixing a Critical, High or
  Medium finding in production code.** Everything else is fixed, pushed, and
  merged with no new round:

  | Fixed                                                       | Re-request? |
  | ----------------------------------------------------------- | ----------- |
  | Crit/High/Med in `src/` (or the equivalent production tree) | Yes         |
  | Documentation, JSDoc, code comments, PR-body mismatch       | No          |
  | Naming, wording, formatting, plurals                        | No          |
  | Anything in a test, probe, fixture, or `scripts/`           | No          |

  **The row is decided by the files the fix changed, not where the finding was anchored.** Once
  you push past a round, the gate weighs it by the files changed between the commit it reviewed
  and the head: a production-anchored finding fixed only in a test or doc earns no round, and a
  test-anchored one fixed in production code does. No `## Settled` entry is needed for either.

  **The `scripts/` row is about a feature's supporting probe, not about a PR
  whose product is the script.** On a tooling PR the script _is_ the production
  code, and a defect in it earns a round like any other. Read the row as "code
  that cannot break the app", not as a path.

  **The same inversion holds for prose.** On a PR whose deliverable IS text — a
  copy module, a brief, a property table — findings on that text are the whole
  product, not doc-sync. One such PR took twelve findings across two rounds, every
  one a factual error in prose, in a diff that renders nothing: a caption naming
  two wrong glyphs and a wrong subject, a badge whose caption taught the opposite
  of the badge, a `low N` described as counting orders when it counts units.
  Every one of those ships to a reader. Ask what the PR delivers, then read the
  rows.
  | Anything Copilot itself calls non-blocking or a nit | No |

- **Batch the round.** Fix everything the round raised in one push, then one
  re-request. Never fix-push-fix-push within a round. One PR ran 22 commits
  against 37 rounds — roughly one fix per round, and one of those commits was
  titled "Two probe bugs I shipped one round ago."
- **Mutation-check a fix that ships with a test, in CI or not at all.** Push a
  commit that deliberately breaks the fix, confirm CI fails on the new test, then
  push the revert. It is the only thing that proves the test measures anything:
  two vacuous tests were caught this way in one run, including one asserting a
  `requestAnimationFrame` callback without flushing one, which passed with the
  fix removed. If a CI round trip is not worth it for this fix, skip the check and
  do not claim it. Never revert and run the test locally (the local gate above).
- **Sweep a class by grep, not by reading — and a class is not only a nit.**
  Copilot reports one occurrence of a pattern it could report twenty times, and
  each unswept sibling costs a full round. On the first spelling / wording /
  formatting / plural nit, grep the whole file for the category and fix every hit
  in the same push.

  **The same applies to logic.** When a fix adds a new conditional, grep every
  sibling consumer of that data in the file before pushing: the branch you just
  taught about a new state has siblings that were not taught. One PR spent rounds
  2, 3 and 4 on a single defect this way — copy that assumed an import, on a door
  where nothing was imported — each round finding the next sentence. The gate now
  prints the previous round's finding text beside the current one so a repeated
  CAUSE is visible even when it lands on different files. If you claim a class
  is swept, a grep command produced that claim — one run declared a plural class
  swept by eye and missed `1 file · 1 items`, every new account's first state.

## 6 · Push-backs: once, in writing, machine-visible

Push back when a comment is technically wrong, conflicts with a prior ratified
decision, or violates YAGNI — stating the standard it rests on. "Defer for later"
is never a reason.

Then **record it in a `## Settled` section of the PR body**: the finding, and the
reason it was declined.

**Write the body with REST, and read it back.** `gh pr edit --body-file` returns
a GraphQL error about Projects (classic) deprecation on some repository
configurations and **writes nothing**, while the exit path still looks
successful. One PR lost two rounds to this: both push-backs were recorded, the
body was never written, and rounds 2 and 3 re-raised the same objections into a
`## Settled` section that did not exist.

```bash
gh api -X PATCH repos/OWNER/REPO/pulls/N -f body="$(cat prN-body.md)"
gh pr view N --json body --jq .body | grep -c "<a phrase from the entry>"
```

Name every scratch file after its PR or task (`pr<N>-body.md`, `<branch>-notes.md`), never a
generic `pr-body.md`: subagents in one session share one scratchpad, and one agent once pushed
another PR's body onto its own, twice. Before writing a body from a file (REST or `--body-file`), read the file back and
check it is this PR's.

The read-back is the same rule as §1's "a 200 is not proof", applied to the PR
body: the mechanism §6 depends on is invisible when it fails. A repeat of a listed finding gets a one-line pointer to
that entry — not a fresh argument.

**Name the file the finding landed on, in backticks.** The gate reads that
section and stops a declined finding from classifying a round as substantive —
so a finding that is simply wrong can no longer hold the merge bar at zero for
ever. It matches on the path the finding was reported against, which is not
always the file your reasoning is about: a claim that a surface is untested is
declined by naming the surface, not the test that disproves it.

**Name the round, too.** An entry discounts its file only in the round it
settles, never in a later one:

```markdown
## Settled

- `src/lib/orders/fill.ts` (round 1): "add a fallback line item…". Ruled the next PR.
- `novelty.ts` (rounds 3, 5): the surface is tested; five mutation-checked cases.
```

The gate reads the FIRST round phrase on the entry's line (`round 3`, `rounds 2, 4`,
`rounds 3-5`), so put it before the reasoning. A round your prose mentions later
("round 2's fix") is not part of the declaration; reading it once discounted a
real Medium. A line that names no round discounts the file only in the first
round that flagged it. A NEW finding a later round raises on the same file
counts in full, because nobody declined it. The old rule discounted the file in
every later round, and it faked a green twice: one PR swallowed a round-4
Critical under an entry written for round 2, and another swallowed a round-3 High
under an entry for a deferred round-1 item.

If a later round posts the SAME wrong finding again as a new comment, add that
round to the line (`rounds 3, 5`). That is the escape valve: a wrong finding
still cannot hold the bar at zero, and every round you discount is written
where a reader can see it. Only write an entry for a finding you pushed back
on. A finding you fixed gets a reply pointing at the commit, not an entry.

One run declined the same finding thirteen times, retyping the same reasoning
each round. It cost real tokens and buried each round's genuinely new findings
underneath it.

Before rejecting an accessibility or structure finding, check the design
handoff's own tree first. A finding the spec explicitly specified has to be
accepted, and reversing a rejection costs a round.

**The person who owns the product can overrule a ratified spec; you cannot.**
When a finding cites a contract the PR breaks, stop the loop and put the evidence
to the user as a scope decision — naming the contract, the clauses broken, and
what accepting the breach costs. If they overrule it, `## Settled` is the
vehicle, and the entry carries four things: the contract file, the decision, the
date, and the cost that was accepted. That entry, with the rounds it answers, is
what makes the gate discount the finding, and what tells the next design round
this was chosen rather than missed. A re-raise in a later round is added to the
line, as above.

## 7 · Convergence: watch the surface, not the round count

**There is no early cap on rounds worth fixing — and there is a hard stop at
twelve.** Below the stop, a round is never refused for its number: rounds 8+
still return genuine defects, including defects introduced by the previous
round's fixes, on docs PRs as well as code. One PR's last eight rounds produced
seven genuine findings out of eight, among them a 44px touch target that existed
in the class list and nowhere on screen, clipped by an `overflow-x-auto` parent,
plus a sticky head that still moved under the reader's thumb. A docs-only PR was
still finding real arithmetic errors at round 8. Late rounds find real defects;
that is why the stop is at twelve and not lower. At twelve scored rounds (errored
and stale reviews do not count) or 4 hours in review, requesting stops and the PR
merges with what is outstanding reported — see the end of this section.

What predicts "stop" is not the round number. It is whether findings land on
**new surface or the same one**.

**The three-round rule.** When the same function or component draws findings in
three consecutive rounds, the next action is a **scope decision, not another
fix**. Ask whether the code should exist.

**At four consecutive rounds the gate blocks the re-request and the merge**, and the escape is
to record the ruling in `## Settled` naming the file. Any mention releases the
block, with or without a round, because it discounts no finding.

**It fires only on a file the PR did not create**, because the rule mis-reads a
PR that introduces one component: there, that file is the only place a finding
CAN land, so repeat findings are the loop working and blocking them strands the
work. What this catches is code that already existed and whose meaning the
review keeps relitigating.

**Value decays sharply by round, and the shape is consistent.** Across three
measured runs, rounds 1–2 returned the security holes and the missing surfaces;
rounds 7+ returned successive refinements of one word's semantics. That is not
an argument for a lower cap — round 9 on one PR here returned a real bundle
defect — but it is an argument for raising the bar as rounds accumulate: **after
round 6, only a Critical or High finding in production code earns another
round.** Everything else is fixed, pushed and merged.

**Each round's fix is the next round's surface.** The gate warns about files
added late and the warning has no teeth by design, but treat it as a signal to
stop adding: after round 3, a finding that wants a NEW FILE becomes a follow-up
unless it is Crit/High in production code. That is deliberate: what
ends an oscillation is a decision, not another patch. On one PR one line drew
findings in six consecutive rounds — rounds 5 and 6 contradicting each other
outright, each fix correct and immediately superseded — because every round asked
a question about MEANING that a code reviewer has no standing to settle.

**A finding about what something should MEAN is not a review finding.** Whether
a legend decodes one vocabulary or two, what a mark says on a surface that draws
plates instead of rows — those are design questions that surfaced during review.
They go to the design queue as a ticket. A reviewer can say the code does not do
what it claims; it cannot say what the thing ought to be.

> A 35-line focus-rescue mechanism took five rounds: fired on fresh page load,
> fired long after an unrelated click removed the control, missed hidden
> `md:flex`, landed on a target clipped by a scroll container, and didn't cover
> the phone sheet. Every finding correct, every fix correct — guarding a case
> nobody could demonstrate a user hitting, which no other route handled. Deleting
> it closed five rounds of findings at once.

Repeated findings on one small surface mean the surface is over-built.

**After round 3, a fix that ADDS BEHAVIOUR becomes a follow-up, not a fix.** The
obvious form is a new file — a probe, a test, a script — and one PR ran ten
rounds off a single real comment, each round reviewing the probe the previous
round had asked for. But the file is the symptom. The test is:

> Had this finding arrived at round 1, would it have been in this PR's scope? If
> the honest answer is "no, but it is adjacent", it is a follow-up.

A finding can be real, and the behaviour that answers it can still be out of
scope. On another PR round 4 reported that the compact filter sheet did not
announce a new aside — true, and the duplication behind it predated the PR. The
announcement written to fix it added no file, so no rule fired, and it drew
findings in rounds 5, 6, 7, 9 and 10 before being deleted in round 10. Six
rounds to arrive back where it started. **Findings landing on code the PR itself
created, three rounds running, is the signal** — the gate now says so in one
line, because the three-round rule watches a single PATH and will not see it when
the findings move between a component and two probes.

**Twelve rounds is a hard stop on requesting, not a reminder to check in.** At
round 12 (scored rounds only; errored and stale reviews do not count): stop requesting. Fix anything outstanding that is Crit/High/Med in
production code, merge, and report what you left and why. There is no round 13.
The same applies at 4 hours open in review, whichever comes first.

This is not a licence to merge past the bar — if genuine Crit/High/Med findings
in production code are still open at round 12, that is the thing to report, and
it means the three-round rule should have fired several rounds earlier. One PR
reached **37 rounds over 11 hours** with 15 of its 24 findings on a single
component, and its last outstanding findings were null-equality holes in a browser
probe.

## 8 · The merge bar

- No unresolved Critical/High/Medium findings, **and 2 CONSECUTIVE successful
  rounds** — a trailing streak, not a count. Four clean rounds out of six does
  not meet it if a finding landed between them. This is deliberate: a finding
  proves the previous clean rounds were reading code that has since changed.
- **§7's hard stop is a third door out of this bar.** At twelve rounds or four hours the bar is
  released, because §7 forbids the only thing that could satisfy it: asking for another round —
  except on a destructive path, where the hard stop ends requesting but the merge waits for the user.
  Left as separate rules the two deadlock, and the gate ends up printing both "merge and report"
  and its own refusal to allow it. Copilot re-posting threads it cannot resolve is what makes that
  reachable — a finding fixed in round 2 comes back every round after and marks each one dirty.
- **1 successful round suffices when returns are diminishing, and the GATE
  decides that, not you.** Four or more rounds where the last three produced at
  most one finding between them. It is computed rather than claimed because an
  agent that obeys the gate — which it should — could never invoke a clause only
  the gate can grant. One PR had two textbook cases and used neither for exactly
  that reason.
- **1 round also suffices when the last fix touched only copy strings and their
  tests.** The gate recognises copy by its default copy-module path,
  `src/lib/copy/**`; strings kept in any other layout are scored as product code,
  and this bar does not apply to them. The reasoning is §9's doc-only rule: two verification rounds
  is ~25 minutes to confirm a sentence, and a string cannot break a contract the
  way a branch can.
- **A PR the USER reviewed themselves needs one clean round, not two.** Put a
  `## Reviewed by <name>` heading in the PR body. The gate parses it exactly as
  it parses `## Settled`, prints who claimed it, and lowers the bar to one.
  Deliberately a body block rather than a path rule: relaxing the bar for
  `src/components/**` would silently downgrade real code that happens to live in
  a components directory, and deliberately not an env var or a CLI flag, because
  the agent must not be able to set it for itself.

  **NEVER write this header yourself. It is the user's input, not yours.**
  Every other section of a PR body is your record of your own work; this one is a
  claim about what somebody else did, and writing it grants you the relaxed gate
  the gate exists to withhold. It goes in only when the user has added it, or has
  told you in conversation that they reviewed the PR — in which case say so in
  the entry. Inheriting it from a previous PR's body is how this failed: 13 PRs
  carried the header, the user had written 3-4, and 4 of them merged on a single
  round because of it.

  **It cannot be verified, and a guard that tried would fire on the honest
  case.** GitHub forbids approving your own pull request, and reading a PR
  creates no review event, so the API records zero human reviews on the user's
  genuine ones exactly as it does on a fabricated header. There is no check to
  add here. What keeps it honest is that you do not write it, and that the gate
  prints every use so the user can audit:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/pr-review/pr-gate.mjs" --audit-reviewed [owner/name]
```

**Two things it never relaxes.** Unresolved Critical/High/Medium findings still
block the merge — the bar is about how many clean rounds trail, never about
ignoring findings. And it does not apply at all on a destructive path; the gate
detects those from the diff and says so instead.

- **Except on a destructive path.** Any diff issuing a DELETE, an overwrite, or a
  wholesale replace of user data gets rounds until a clean round follows another
  clean round. One such PR returned zero comments at round 8, then found at round
  9 that a planner reported "nothing changed" while ignoring rows the apply path
  replaced wholesale, and two more real defects at round 10.
- Green CI is not a substitute for a round. No auto-merge flags, ever.
- **Red or pending CI blocks the merge, and the gate enforces it** (since 2026-09-22, after
  a PR merged over a failed build). The bar is rounds AND a green head. Merge in its own
  command after the checks finish: a chained `gh pr checks --watch && gh pr merge` is judged
  before the wait runs, so the hook denies it while anything is pending.
- **When the bar is met, merge. Do not fix one more thing first.** An outstanding
  nit at that moment either rides in the merge commit with no re-request, or
  becomes a follow-up. It never becomes another round. One PR hit two consecutive
  green rounds on the same commit — bar met, nothing above Low outstanding — then
  fixed the remaining nit, re-requested, and spent ten more rounds and two and a
  half hours before it was where it had already been.
- **Merge yourself once the bar and CI are green** — interactive sessions
  included. Do not park a green PR on a confirmation. A pending design
  ratification is not a blocker; record the amendment, merge, and put it in the
  close-out. Open questions go in the PR body, where they stay visible and
  reversible.

## 9 · Doc-only PRs

Briefs, specs, plans, property tables, trackers, READMEs — anything with no
runtime. The gate also counts a script edit whose every changed line is a comment, and a
`plugin.json` or `package.json` change to the top-level `version` alone, as having none.

- **No Copilot round at all.** Owner ruling, 2026-10-30: never request a Copilot
  review on a design or documentation PR. Copilot is billed per review, and a doc PR
  buys the least from it. Read the diff yourself, fix what is wrong, and merge on
  green CI. The gate sets the bar to zero rounds and refuses the request.
- The bullets below date from when doc PRs took one round. They still describe how
  carefully to read your own doc diff before merging.
- **Unless a round returns a factual error** in a spec, brief or property table —
  a missing enum case, an evidence table that doesn't support its own claim, a
  brief describing a route's behaviour wrongly. Those cost a design round later.
  Fix and keep going.
- **"Keep going" means keep FIXING, not keep REQUESTING.** This exception raises
  how carefully you read a round; it does not buy another one, and it never
  overrides §7's hard stop or §8's bar. One agent read the exception as licence
  to re-request at 16 hours open with the bar already met, and was denied by the
  gate — correctly. Fix everything the round named, sweep its class, merge.
- When you do keep going, respond with an **inventory of the whole class**, not
  the one instance the review named. One PR ran fourteen rounds by patching the
  file each review pointed at and waiting for the next one to name its sibling.
- Draw the scope line explicitly when findings start landing on staleness the PR
  did not create. Say so in the PR body and merge.
- **A round landing only on copy strings needs one clean round, not two** — on
  a code PR as well. A copy module (the gate reads `src/lib/copy/**`, the default
  copy-module path it recognises; copy kept in any other layout is scored as
  product code, so this bar does not apply to it) cannot break a
  contract the way a branch can, and a project that runs a copy-drift check in CI covers the
  drift case, so two rounds is ~25
  minutes to confirm a sentence. The gate applies this automatically.
- **Bundle doc changes.** Multiple doc changes in flight belong in one PR.
- Never open a spec-only or plan-only PR. Spec, plan and code land together and
  are reviewed once. For a large feature, have a subagent review the plan before
  implementation instead — Copilot is tuned for code and reads prose plans
  poorly.

## 10 · PR structure

**No stacked PRs.** One PR at a time per feature line, based on `main`. Open,
review, merge, then cut the next off fresh `main`.

Stacking looks like parallelism and isn't: nothing merges until the root does,
every rebase re-triggers review on every child, and a child's PR diff silently
contains its parent's work — so the reviewer reads the parent again and the child
gets reviewed against a diff that isn't its own.

**Copilot refuses files past roughly 600–1000 lines** — "wasn't able to review
any files", observed on a 3051-line file, twice, and re-requesting no-ops. Treat
~600 lines as the safe per-file ceiling. Split a large plan into an index plus
per-PR sub-files rather than one document.

**Split on FILE COUNT, not line count.** Measured over the 30 PRs merged on
2026-09-15: `correlation(files, rounds) = +0.73`, `correlation(lines, rounds) =
-0.00`. A 5,792-line PR across 12 files took one round; a 1,096-line PR across 38
files took eleven. Review surface is per-file — each file is a context the
reviewer loads, and a long file is one context however long it is. (One
repository, one day, n=30 — strong enough to move the gate, not to be a law.)

**Size gate before opening.** Over ~20 files, split it (the gate also warns past ~800 runtime
lines, excluding prose and generated files, as the weaker of the two signals) —
and name the PR boundaries **in the plan**, before implementation starts. A
single 67-file feature PR took 32 rounds over 12.5 hours, blocked another agent
for a day, and by round 25 was surfacing defects its own earlier rounds had
introduced. The natural cut is nearly always the plan's own task groups:

1. Data — columns, transform, ingest, migration.
2. Pure model — computation, filters, all unit-tested.
3. Read path and copy.
4. Routes and components.
5. Severable extras — their own PR by definition.

If a plan's tasks genuinely cannot be cut, say so and get agreement before
starting, not at merge time.

**Draining a stack that already exists.** Bottom-up, one PR under review at a
time. Do not request review on a child while its parent is open. Watch for a
squash-merged parent — the child still carries the parent's pre-squash commits,
so a plain rebase replays them all and conflicts:

```bash
git rebase --onto origin/main <parent-branch> <this-branch>
gh pr edit N --base main
```

Then verify the diff shrank to this PR's own work (`gh pr view N --json
changedFiles,additions`) before requesting review.

## 10b · The pre-open gate — where the remaining cost actually is

Once the loop's own waste is gone, what is left is findings that are genuinely
right. Measured across one seven-PR feature: after the round-saving rules landed,
counts stayed at 7 and 2 per PR — not because rounds were wasted, but because the
code kept giving review real things to find. **Rules can only stop wasted rounds.
These stop the findings.**

Every one of the five below was paid for by a real round on that feature.

1. **Every raw `sql` template gets a probe before the PR opens.** Typecheck
   cannot see inside a template literal. One PR shipped `o.shipped_at` — a
   column that lives on another table — and the route would have 500'd for every
   visitor. The probe written afterwards, at review's insistence, caught it on
   its first run. If a query is worth writing by hand, it is worth running once.

2. **Never hand-roll a query when a loader exists.** A hand-written price CTE
   cost three rounds of currency / staleness / liveness semantics and was then
   replaced wholesale by an existing `loadRates` loader, which already encoded all of it. Before
   writing SQL, grep for a reader of the same table.

3. **Load the real route, not the component.** A link built specifically for the
   user with no saved items never rendered for them, because the page returns
   its empty state before mounting the bar that holds it. The component test
   passed. Routes have gates that components do not.

4. **Verify a structural claim before writing it down.** "This can never take a
   warning colour", "membership scoping is the guarantee", "the card view keeps
   the key" — three claims written into PR bodies and code comments on one
   feature, all three wrong, each costing a round. If the sentence asserts
   something is impossible, prove it or soften it.

5. **Build the acceptance artifacts before opening, not after.** The single worst
   finding of that feature — the phone had none of the feature, because props
   were threaded to a component that never read them — is exactly what a contact
   sheet shows in one glance. Running it first turns a review round into an edit.

### The cold-eyes pass — ON TRIAL, run it on every PR

Items 1–5 are the author checking their own work, which is the weakest form of
review there is: the person who wrote the code already believes it. So one more
step, immediately before `gh pr create`:

**This dispatch needs the user's authorization for subagent use.** Most sessions
carry a system-prompt line forbidding subagent use unless the user requested it,
and it outranks this skill — correctly; this document cannot grant it. A project
grants it standing by saying so in its `AGENTS.md` / `CLAUDE.md` (or in
`.claude/fwd/pr-review.md`). Without that grant, ask the user once, and if they
decline, skip the pass. A grant covers **this** pass and nothing else; any other
subagent use still needs asking.

**Dispatch a general-purpose subagent with `${CLAUDE_PLUGIN_ROOT}/skills/pr-review/precheck-prompt.md` as its prompt.**
Not a fork. A fork inherits this conversation — it knows what you meant, and
reads the code as intended rather than as written, which is the one property that
makes it useless here. The agent gets the branch and nothing else; the prompt
forbids it the plan and the handoff for the same reason.

It is a strictly weaker reviewer than Copilot — same model family, so it shares
your blind spots even when it does not share your intentions. It is also ~90
seconds against 8–18 minutes per Copilot round. Its job is not to find what
Copilot finds. It is to strip the mechanical findings — an unswept class, a stale
PR-body claim, a test that passes with the fix removed — so Copilot's rounds
spend on the judgment calls only it catches.

**Verify every finding before acting on it.** Subagent audit claims contradict
each other and a wrong one actioned costs more than the round it saved. It
generates findings; it does not rule on them. And it never gates the PR — fix
what is real, note what you declined, open.

Then record it, before opening:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/pr-review/precheck.mjs" record <file>   # or - for stdin
```

The ledger lives in the plugin's data folder (`~/.claude/plugins/data/fwd-fwd-stack/`, or under
`CLAUDE_CONFIG_DIR`), never beside these scripts: it holds finding text from private
repositories. A PR's first `score` runs in a checkout of its branch: the row is found by the
branch name. Re-scoring a PR that already has a row can run from any other git checkout with
`--repo=owner/name`.

**Run it on EVERY PR while the trial is open, including the ones you feel sure
about.** An agent that runs the pass when it feels uncertain produces a
self-selected sample, and a self-selected sample cannot answer the question the
trial is asking. This is not a judgment call.

After round 1 lands, score what the pass predicted of that round's
Critical/High/Medium findings — your judgment, per finding, because the two
reviewers describe the same defect in different words:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/pr-review/precheck.mjs" score <pr> <predicted> <round1-total> --fixed=N --shipped=M --kind=K [note]
```

**`--fixed=N` is the number that matters, and it is not a ratio.** It counts the
pass's findings you fixed _before opening_ — its actual output. The
`predicted/round1` hit rate cannot see those: a defect fixed pre-open never
reaches round 1, so the pass scores **zero exactly when it worked best**. One
agent's clearest case scored `1/0` — the pass caught an inset shadow painting
below opaque full-bleed art, which would have shipped looking identical to the
bug the PR existed to fix, past a probe that passed the broken build. The ledger
reports the two separately and never divides one by the other, because a row
whose round 1 raised nothing has no denominator at all.

**`--shipped` counts DEMONSTRATED reach, not plausible reach.** On a prose PR
"past your own tests and probes" is trivially every finding, because nothing
tests prose — so counting them all makes the column incomparable with a code row
and inflates exactly the number a verdict leans on. Count a prose finding only
where you can point at something that consumed it: a design round quoting the
pre-correction ask, a dependency table built on the wrong figure. Otherwise zero.

**`--shipped=M` is the subset of those that would have SHIPPED** — past the
author's own tests, probes and checks — rather than merely costing a round. Keep
it separate, because the two halves are priced differently and only one of them
decays. As the loop got faster (rounds per PR 8.3 to 3.0 in a day), a round
removed fell from ~75 minutes to ~10. A defect that would have shipped is worth
the same at either speed. A verdict argued on time saved prices the pass by its
cheaper half.

`--kind` is what the PR's risk **was** — `arithmetic`, `layout`, `modelling`,
`wiring`, `prose`. The five classes are not equally reachable across those: a PR
whose core is a pure function with nine unit cases and whose real danger is a
modelling judgment — _may a client predict the server's allocation at all_ — is
outside what any of them target, and a low score there says nothing about the
pass. The ledger breaks the number down by kind and **withholds the verdict while
every scored PR is one kind**, because that average is a fact about the sample.

**Agreement between agents is not independent evidence.** Three sessions
converged on "the pass catches the mechanical half and cannot reach the judgment
half" before any number existed — but all three were running similar feature
shapes, on the same app, on the same day, at the same model. That is precisely
the correlation that makes concurrent agreement weaker than it looks. Report it
as suggestive; it becomes evidence when it survives a PR line whose risk is
mostly arithmetic — a query, a figure, a migration — rather than layout or
modelling.

**Do not change `precheck-prompt.md` while the trial is open.** Rows scored
before and after a prompt edit measure different instruments, and the ledger has
no column that would record which one produced a row. A hypothesis about how to
aim the pass better is a change for AFTER the verdict, however good it looks.

**The hypothesis currently worth testing, once kinds are in:** the pass's misses
cluster on defects that are an ABSENCE spanning two files — a cost drawn but
never spoken, a payload whose destination is in another module, a selector that
could never match the state being asserted. A diff has no hunk for an absence.
Its hits cluster on what is visible inside one file: a stale claim, a class fixed
in one place and not its siblings, a wrong number. If that survives the kinds, it
says where to point the pass — which is a better answer than whether to keep it.

At three scorable PRs (round 1 raised findings, current era, fewer than half of unstated kind)
of at least two kinds the ledger prints a verdict: **≥70%** cut Copilot to one
confirmation round, **30–70%** keep both, **<30%** the hit rate is low: read it with the pre-open fix count before
recommending deletion, because a pass that fixes what it finds before the PR opens scores badly
here by construction. Bring the
verdict to the user rather than acting on it — this section stays a trial, not
policy, until that number exists. Every other rule in this document was written
after a measured cost; this one currently has an argument instead.

## 11 · Before opening at all

Do not open a PR, or request review, on content that has not passed your own
first assessment. If something upstream must be fixed first — Design owes a
token, a handoff has a known gap — surface it and hold. Copilot review is for
finding new issues, not confirming known ones.

Exception: a spec or plan written during a brainstorm is an input to the next
step, not finished work. Commit it on a branch and hand over the path. Do not
push, open a PR, or start a round until the designs are ready and it's asked for.

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
