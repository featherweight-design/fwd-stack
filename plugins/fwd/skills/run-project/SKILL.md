---
name: run-project
description: >-
  Use when starting or restructuring how a project's work is run with several agents: the
  standard operating model of one orchestrator session, a small capped set of lane sessions for
  PR-owning work, and subagents for bounded reads. Covers which work goes to a lane and which to a
  subagent, how to start a run, the lane brief, and the lane cap. Read before opening a lane or
  dispatching a subagent for project work.
---

# run-project

The standard way to run a project with agents. One **orchestrator** session coordinates and is the
user's single point of contact (the `orchestrator` skill). A few **lane** sessions own PRs end to
end (the `lane` skill). **Subagents** do bounded, read-heavy jobs and return a summary. The
orchestrator itself never builds.

**First, read the project's own rules.** If `.claude/fwd/run-project.md` exists in the project, read
it before anything else. Its rules add to these and win where they conflict. Settings live under
`orchestrator` in `.claude/fwd.json`: `maxLanes` (default 3), `maxOpusLanes` (1), `priorities`
(`boards/priorities.md`) and `rotateAt` (an optional hard ceiling, off by default). The machine
settings the kit assumes are in §6.

## 1 · Lane or subagent: decide by the shape of the work

Measured on a long multi-lane run, the two tools fail in opposite ways.

- A **lane** keeps context across PRs, holds its own watchers and stop guard through hours of
  review and CI, and the user can talk to it. Its costs are context growth (up to the compact
  window, re-read on every turn), manual rotation when it drifts, stale checkouts, permission
  prompts a peer cannot answer, and terminal sprawl.
- A **subagent** starts fresh and inherits the orchestrator's permissions, and its result comes
  back as a summary, so the orchestrator stays lean. But it dies with the orchestrator, cannot hold
  a watcher or a cross-session wait, and cannot talk to the user.

| Work                                                                          | Goes to                                                                                          | Why                                                                |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| A PR, or a line of PRs, that waits on review, CI, deploys or staging runs     | **Lane**                                                                                         | Waits last hours and need a watcher the session owns               |
| Follow-ups on a surface a lane just built, while the lane has not drifted     | **The same lane**                                                                                | Its context is the asset                                           |
| Audits, research, pipeline and code maps, measurement                         | **Subagent**                                                                                     | Bounded, read-heavy, and the summary is all the orchestrator needs |
| Plan and spec builder-checks, readiness audits, the `pr-review` pre-open pass | **Subagent** (general-purpose, read-only, never a fork)                                          | A cold reader is the point. A fork reads the code as intended      |
| Drafting a doc, brief or plan that a lane will PR                             | **Subagent** drafts, **lane** PRs                                                                | Keeps PR rounds out of the orchestrator                            |
| A short single-PR task with a short review (a copy fix, a config pin)         | **Subagent with worktree isolation**, if the orchestrator owns the review wait; otherwise a lane | Saves a terminal, but only when the wait is cheap                  |

**Fewer lanes, more subagents.** Run at most `maxLanes` lanes per project, typically 2–4. A new lane
must earn its terminal by owning PRs with external waits. Close a lane that has no ranked work
instead of keeping it in reserve.

Every lane and subagent pays for the project's agent docs at start. Keep `AGENTS.md` and
`CLAUDE.md` short, and move detail into skills and `.claude/fwd/` files that are read on demand.

## 2 · Starting a run

1. Open one orchestrator session in the project's main checkout. It loads the `orchestrator` skill
   and reads the priorities file, the ruling log, the roadmap if the project has one
   (`orchestrator` §4), and any open lanes' handoffs.
2. Take the roster of open lanes from the lanes' handoffs and `ListAgents`, not from a
   measurement: `node "${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/lane-context.mjs"` lists recently
   active sessions (the orchestrator included, and none idle for over two hours), so use it only to
   measure each lane's context. Rotate a lane that has compacted several times and drifts before
   giving it new work (`orchestrator` §7).
3. For each ranked item the user has approved, decide its shape (§1). Write a brief (§3) for each
   lane item, and dispatch subagents for the rest.
4. Arm the stall watchdog (`orchestrator` §6). When the user leaves, open the away window and arm the
   autonomous-run guard for its whole span (`orchestrator` §6). While it is open, no lane stops for
   context (`orchestrator` §7).
   Every wait, by every session, runs in the background (`run_in_background`, the watchdog or
   Monitor) so the notification wakes it; never in the foreground, present or away
   (`orchestrator` §6).

## 3 · The lane brief

Every brief carries all of these. A missing STOP condition is how a lane ends up building a
product call.

```text
PROMPT FOR: <new session | lane XX>, lane <id> (<area>), orchestrator <orchestrator session name>
This is your go: start now. First message to <orchestrator session name>, within your first turn:
  your context size and your plan. Never ask the user anything; send every question to
  <orchestrator session name> and keep working on what it does not block.

MODEL: <paste the line from model-pick.mjs (run-project §5)>
WHAT AND WHY: <the task, in the user's words where possible>
EVIDENCE: <file:line, PR, issue, or the measurement that started it>
OUT OF SCOPE: <what this lane must not touch>
STOP AND REPORT if it needs: a design call, a product call, spend, a new feature switch,
  or anything outside this brief. Report it with options and a recommendation,
  and keep working on the parts it does not affect.
STANDING RULES: the project's agent docs; a feature branch in a worktree from origin/main,
  never main, and no --delete-branch from a worktree; production and staging are read-only;
  list every scratch database branch you create; name scratch files after their PR or task
  (pr<N>-body.md), never a generic name, and read a body file back before --body-file;
  typecheck and lint only, never tests or a production build locally, CI runs them
  (pr-review §3); every wait runs in the background (`run_in_background` or Monitor), never
  a foreground loop (orchestrator §6); full pr-review on every PR; copy through copy-review;
  UI only on a handoff with a READINESS verdict, a `## Design review` table and a contact
  sheet in every UI PR, design/ as reference only; when the task ends, stop your dev servers
  and remove your worktrees (lane §2).
COORDINATION: <other lanes on nearby files, their branches, who rebases; reserved
  migration numbers / product-call numbers>
STOPPING POINT: <"merged, and production proven (`orchestrator` §3: the domain serves the new deployment and a database-backed request works)" | "plan sent to me" | "report before building">
```

A restart prompt uses the same template: the handoff's path goes in EVIDENCE and its exact next
step in WHAT AND WHY. Its first lines are always the go, so a restarted lane never waits on the
user.

## 4 · Subagent dispatch

- **Subagents need the user's grant.** A session's system prompt usually forbids subagents unless
  the user asked for them. A project adopts this model by saying so in its `AGENTS.md` or
  `CLAUDE.md`, or in `.claude/fwd/run-project.md`, and that grant covers the subagent work in §1.
  Without it, ask the user once, then record the answer there. `pr-review`'s pre-open pass has its
  own grant (§7).
- Give the subagent the question, the paths, and what to return (a table, file:line findings, or a
  verdict). Do not give it the whole conversation.
- Use a fresh general-purpose agent for cold-eyes work (reviews, audits, builder-checks), never a
  fork: a fork inherits the context and reads the work as it was intended rather than as written.
- A subagent never owns a review wait or a merge. The orchestrator, or a lane, owns those
  (`pr-review` §2).
- Treat a subagent's findings as claims to verify, not as rulings.
- Pick the subagent's model by §5, and name it on the dispatch.

## 5 · Model choice

**Sonnet is the default for lanes and subagents.** Opus is for work that needs it, named on the
brief's `MODEL:` line with a one-line reason. At most `maxOpusLanes` (default 1) lanes run on
Opus at once.

**The `MODEL:` line comes from `model-pick.mjs`, decided per PR, not per lane.** Pass the PR's
planned file paths from its plan (as arguments, or one per line on stdin) and paste the line it
prints:

```text
node model-pick.mjs [--orchestrator] [--sonnet-failed "<what failed>"] \
  [--subagent [--read-only]] [--json] <path> [<path>...]
```

First match wins: `--orchestrator` is Opus; `--subagent` is Sonnet, or Haiku with `--read-only`,
always (a subagent is never Opus); `--sonnet-failed` is Opus, naming the failed attempt; a planned
path in money, auth, migrations or security is Opus, naming the path (API routes alone do not
count); anything else is Sonnet. When
the answer is Opus and `maxOpusLanes` Opus sessions are already running, the line says it is
queued for the Opus slot; wait for it rather than opening another session. If the running
sessions' models cannot be read, the cap is skipped and the line says so. The lists below stay as
the rationale.

**Advisory for one week:** an orchestrator that disagrees with the line says so in its ruling log
and follows its own judgment. After that week the line is binding.

- **Opus:** an ambiguous architecture, or a design with no drawn pattern to follow; auth,
  payments, migrations or other security-sensitive changes; a debugging hunt that has already
  failed once on Sonnet; the orchestrator itself; a risky PR's `/code-review` (`pr-review`).
- **Sonnet:** building to a READINESS-green handoff, mechanical refactors, copy, tests, docs,
  scripts, dependency bumps, and bounded read-and-locate subagents. A pure grep-and-report
  subagent can run on Haiku.
- Use a subagent only for a large read, on Sonnet (Haiku for grep-and-report); do small reviews, prechecks and lookups inline, since each subagent starts at about 50K tokens.
- **Escalate, do not pre-empt.** When Sonnet stalls on a piece, the lane reports it and the piece
  moves to a new Opus session with the handoff. Never start on Opus "just in case".

## 6 · Machine settings

The kit assumes these in the user's `~/.claude/settings.json` on every machine that runs lanes:

- `"autoCompactWindow": 300000`: every session compacts at about 300k tokens. Without it a session
  compacts near the model's full window, and every turn re-reads up to that much. A window saved
  per model with `/autocompact` takes precedence over this key, so check `/autocompact` too. If the
  machine uses another window, set `sessionBudget.compactWindow` in `.claude/fwd.json` to match.
- `"env": { "CLAUDE_CODE_SUBAGENT_MODEL": "sonnet" }`: subagents run on Sonnet unless a dispatch
  names another model (§5).

With compaction at 300k, size is no reason to rotate, day or night. A session rotates only when it
has compacted several times and drifts: it forgets the brief, or repeats work it already did. The
handoff written at each PR boundary (`lane` §5) is what a fresh session starts from, and the
`PreCompact` hook steers each compaction to keep the role, the brief's rules, open PRs, watchers,
the away window and the next step.
