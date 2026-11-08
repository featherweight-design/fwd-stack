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
`orchestrator` in `.claude/fwd.json`: `maxLanes` (default 3), `rotateAt` (450000),
`maxOpusLanes` (2) and `priorities` (`boards/priorities.md`).

## 1 · Lane or subagent: decide by the shape of the work

Measured on a long multi-lane run, the two tools fail in opposite ways.

- A **lane** keeps context across PRs, holds its own watchers and stop guard through hours of
  review and CI, and the user can talk to it. Its costs are context bloat (250–400k tokens within a
  day, re-read on every turn), manual rotation, stale checkouts, permission prompts a peer cannot
  answer, and terminal sprawl.
- A **subagent** starts fresh and inherits the orchestrator's permissions, and its result comes
  back as a summary, so the orchestrator stays lean. But it dies with the orchestrator, cannot hold
  a watcher or a cross-session wait, and cannot talk to the user.

| Work                                                                             | Goes to                                                                                          | Why                                                                |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| A PR, or a line of PRs, that waits on review rounds, CI, deploys or staging runs | **Lane**                                                                                         | Waits last hours and need a watcher the session owns               |
| Follow-ups on a surface a lane just built, while its context is under `rotateAt` | **The same lane**                                                                                | Its context is the asset                                           |
| Audits, research, pipeline and code maps, measurement                            | **Subagent**                                                                                     | Bounded, read-heavy, and the summary is all the orchestrator needs |
| Plan and spec builder-checks, readiness audits, the `pr-review` pre-open pass    | **Subagent** (general-purpose, read-only, never a fork)                                          | A cold reader is the point. A fork reads the code as intended      |
| Drafting a doc, brief or plan that a lane will PR                                | **Subagent** drafts, **lane** PRs                                                                | Keeps PR rounds out of the orchestrator                            |
| A short single-PR task with a short review (a copy fix, a config pin)            | **Subagent with worktree isolation**, if the orchestrator owns the review wait; otherwise a lane | Saves a terminal, but only when the wait is cheap                  |

**Fewer lanes, more subagents.** Run at most `maxLanes` lanes per project, typically 2–4. A new lane
must earn its terminal by owning PRs with external waits. Close a lane that has no ranked work
instead of keeping it in reserve.

Every lane and subagent pays for the project's agent docs at start. Keep `AGENTS.md` and
`CLAUDE.md` short, and move detail into skills and `.claude/fwd/` files that are read on demand.

## 2 · Starting a run

1. Open one orchestrator session in the project's main checkout. It loads the `orchestrator` skill
   and reads the priorities file, the ruling log and any open lanes' handoffs.
2. Take the roster of open lanes from the lanes' handoffs and `ListAgents`, not from a
   measurement: `node "${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/lane-context.mjs"` lists recently
   active sessions (the orchestrator included, and none idle for over two hours), so use it only to
   measure each lane's context. Rotate any lane over `rotateAt` before giving it new work.
3. For each ranked item the user has approved, decide its shape (§1). Write a brief (§3) for each
   lane item, and dispatch subagents for the rest.
4. Arm the stall watchdog (`orchestrator` §6). When the user leaves, open the away window and arm the
   autonomous-run guard for its whole span (`orchestrator` §6). While it is open, no lane stops or
   rotates for context, past `rotateAt` or not (`orchestrator` §7).

## 3 · The lane brief

Every brief carries all of these. A missing STOP condition is how a lane ends up building a
product call.

```text
PROMPT FOR: <new session | lane XX>, lane <id> (<area>), orchestrator <orchestrator session name>

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
  full pr-review on every PR; copy through copy-review.
COORDINATION: <other lanes on nearby files, their branches, who rebases; reserved
  migration numbers / product-call numbers>
STOPPING POINT: <"merged and production health OK" | "plan sent to me" | "report before building">
FIRST REPLY: confirm you have read this, and give your context size.
```

## 4 · Subagent dispatch

- **Subagents need the user's grant.** A session's system prompt usually forbids subagents unless
  the user asked for them. A project adopts this model by saying so in its `AGENTS.md` or
  `CLAUDE.md`, or in `.claude/fwd/run-project.md`, and that grant covers the subagent work in §1.
  Without it, ask the user once, then record the answer there. `pr-review`'s pre-open pass has its
  own grant (§10b).
- Give the subagent the question, the paths, and what to return (a table, file:line findings, or a
  verdict). Do not give it the whole conversation.
- Use a fresh general-purpose agent for cold-eyes work (reviews, audits, builder-checks), never a
  fork: a fork inherits the context and reads the work as it was intended rather than as written.
- A subagent never owns a review wait or a merge. The orchestrator, or a lane, owns those
  (`pr-review` §2).
- Treat a subagent's findings as claims to verify, not as rulings.
