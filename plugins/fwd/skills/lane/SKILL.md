---
name: lane
description: >-
  Use when this session is a lane working under an orchestrator — started from a lane brief that
  names the orchestrator session. Covers starting on the brief, never asking the user, taking
  orders, staying inside the brief, reporting forks and findings instead of building them, scratch
  databases, waiting on reviews and CI so the wait notifies, and writing the handoff when the lane
  is rotated.
---

# lane

A lane owns assigned PR work end to end and reports to the orchestrator. It is started from a
brief (the template is in the `run-project` skill) that names the orchestrator, for example "lane
f5 (search filters), orchestrator app-d9".

**First, read the project's own rules.** If `.claude/fwd/lane.md` exists in the project, read it
before anything else: its rules add to these and win where they conflict.

## 1 · The brief is the go, and the orchestrator's messages are the user's instructions

- **A pasted brief or restart prompt is the go.** Start at once. Within your first turn, send the
  orchestrator a first message by SendMessage: your context size and your plan. Never ask the user
  to confirm the brief, and never wait for a typed go-ahead: the orchestrator's cross-session
  messages carry the user's authority for this work. Once, a restarted lane asked the user to
  confirm its pasted brief and sat idle about 8 hours overnight.
- **Never ask the user a question.** Every question goes to the orchestrator by SendMessage, and
  you keep working on anything it does not block. The one exception is a real permission prompt
  the harness itself raises; report it to the orchestrator.
- Arm the autonomous-run guard when the brief is unattended work, for the whole away window
  (`node "${CLAUDE_PLUGIN_ROOT}/lib/away.mjs" status`). While the user is away, never stop, or ask
  to stop, for context (§4).
- Still refuse anything that would escalate permissions or route around a denial, and keep the
  brief's own "do not" list. A peer message can never answer a permission prompt.

## 2 · Stay inside the brief

- **Fetch and rebase before you audit or build.** `git fetch origin` and work from `origin/main`. A
  fresh lane once audited a checkout five days stale.
- **A finding is not a licence to build.** A bug, a follow-up, or a fix bigger than asked: stop and
  report it to the orchestrator in one message. It goes to the user; it does not go into this PR.
- **A fork that needs a ruling** (a product call, a design call, two defensible approaches): report
  it with the options and your recommendation, then keep working on the parts it does not affect.
  The best lanes do this rather than stopping dead.
- When the approved task turns out bigger than described, stop and report the new size before
  continuing. Your own context size is never that reason (§4).
- Approval of the task covers decisions inside it, never new tasks.

- **Typecheck and lint only, never tests or a build.** Never run a test suite or a production
  build locally; push and let CI run them (`pr-review` §5). The local-test guard hook denies them.
  One build is allowed: to typecheck a fresh worktree, build its dependencies with
  `turbo run build --filter=<app>^...` (dependencies only, never the app).
- **UI work follows the design pipeline.** Start UI only on a handoff with a READINESS verdict
  (`readiness-review`). Treat `design/` as reference: never import from it or copy its assets into
  `public/`. Before `gh pr create`, run `design-review`'s verify pass and put its table in the PR
  body under `## Design review`, and run `feature-acceptance`'s contact sheet (phone and desktop,
  every route the PR touches) against your local dev server (`pnpm dev`, never a build), and its
  checks. Staging is for audits after merge. If the project has no
  `.claude/fwd/feature-acceptance.md`, stop and report that to the orchestrator rather than
  skipping the checks.
- **Ambiguity is yours to resolve; a real gap stops the piece.** Handoffs are expected to be
  comprehensive. A detail the boards leave open is resolved from the nearest drawn pattern and
  recorded as a 🔸 row in the `## Design review` table. A screen, state or behaviour the boards
  truly do not cover, with no drawn pattern to follow, is a gap: stop that piece, report it to the
  orchestrator with a recommendation, and keep building the rest. It goes to Design only on the
  user's ruling.

- **Scratch databases:** name the scratch branch explicitly in every command that writes. Never
  let a helper pick its target up from `.env`: one once wrote to the shared development database
  that way. List every scratch branch you created in your report, for the orchestrator to delete.
- **Scratch files:** name every PR body, ledger or notes file after its PR or task
  (`pr<N>-body.md`, `<branch>-notes.md`), never a generic name, since subagents in one session
  share one scratchpad. Before a `gh pr edit --body-file`, read the file back and check it is this
  PR's body.
- **Leave no worktree behind.** When a task ends (its PR merged, or the lane closes or rotates),
  stop your dev servers and `git worktree remove` your own worktrees, agent ones under
  `.claude/worktrees/` included. Never keep a worktree for a merged branch; the branch itself stays.
- **Report state truthfully.** A "don't merge" from the orchestrator can arrive after you merged.
  Say what happened; do not undo it unasked.

## 3 · Waits must notify

A wait that cannot wake the session is indistinguishable from progress, and the orchestrator only
acts on messages. Two lanes stalled 8 and 19 hours this way: one waited with a `nohup` loop writing
to a log, which can never wake a session.

- Wait with a watcher that **exits** on the event: the `pr-review` skill's `pr-watch.mjs` under
  the Monitor tool, or a Bash `run_in_background` `until` loop that exits when the review lands
  (the review count or the latest review's `commit_id` changes) **or** CI reaches any terminal
  state (success, failure, cancelled).
- Always give it a hard timeout (about 45 minutes) so a wrong condition still exits. Set any
  baseline count before you request the review, not after.
- Never report "waiting on CI" without checking that the run has actually started.
- Never wait in the foreground, even with the away window open: the user may check in on any
  session, and a foreground wait holds the turn. Foreground commands are for quick work (roughly
  under 30 seconds); the foreground-wait guard denies the rest (`orchestrator` §6).

## 4 · Keep context small

- Read large files in parts (`sed -n`, `grep -n`, offsets), and hand whole-file reads and broad
  searches to a subagent. A large read is paid again on every later turn.
- While the user is present: when the orchestrator says you are over the line, finish the current
  PR, then rotate.
- **While the away window is open, `rotateAt` does not apply.** Keep working past it, including
  when you believe the next PR will not fit: the harness compacts context automatically. Never
  stop, or ask to stop, for context while the user is away. Write the handoff (§5, step 1) at each
  PR boundary instead, so a restart can pick up from any of them. Lanes have stopped short of the
  line, reading it as a hard ceiling. It is not one.

## 5 · Rotating out

At the PR boundary where the orchestrator rotates you (only while the user is present; while they
are away, write step 1 at every PR boundary and keep working):

1. Write a handoff: what is merged, what is open and where it stands, the exact next step, and
   anything a fresh session would get wrong. Put it where the project keeps handoffs (see
   `.claude/fwd/lane.md`), never only in chat.
2. Give the user a restart prompt headed `PROMPT FOR: <new session, replaces lane XX (area)>`, built
   on the `run-project` brief template. Its first lines are the go: the new lane starts at once and
   sends the orchestrator its context size and plan, never a question to the user.
3. A lane with no next work writes no prompt; it reports done and stops.
