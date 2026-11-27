<!--
  Add this to the project's CLAUDE.md or AGENTS.md. Without a grant, a session's own rules forbid
  subagents, and run-project section 4 cannot dispatch any. Keep the project's agent docs short.
-->

## Agents

This project runs with the `fwd` plugin's operating model (`run-project` skill). Subagents are
authorized for the bounded read work that skill names (audits, research, code maps, builder-checks,
readiness audits) and for the `pr-review` pre-open pass. A subagent never owns a review wait or a
merge.

Project rules for each skill live in `.claude/fwd/<skill>.md`; settings live in `.claude/fwd.json`.
