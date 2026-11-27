# Templates

Starter files for a new project. The README's "New project checklist" copies from here. Replace
every `<placeholder>`, then delete the header comment.

| File                           | Copy to                              | Read by                                                    |
| ------------------------------ | ------------------------------------ | ---------------------------------------------------------- |
| `fwd.json`                     | `.claude/fwd.json`                   | run-project, feature-acceptance, ui-audit, ui-probe, hooks |
| `fwd/orchestrator.md`          | `.claude/fwd/orchestrator.md`        | orchestrator                                               |
| `fwd/run-project.md`           | `.claude/fwd/run-project.md`         | run-project                                                |
| `fwd/feature-acceptance.md`    | `.claude/fwd/feature-acceptance.md`  | feature-acceptance (stops without it)                      |
| `boards/priorities.md`         | `boards/priorities.md`               | run-project, orchestrator                                  |
| `agent-docs.md`                | append to `CLAUDE.md` or `AGENTS.md` | run-project section 4 (subagent grant)                     |
| `CLAUDE.user.md`               | append to `~/.claude/CLAUDE.md`      | every session (points at pr-review)                        |
| `optional/copy-review.md`      | `.claude/fwd/copy-review.md`         | copy-review                                                |
| `optional/readiness-review.md` | `.claude/fwd/readiness-review.md`    | readiness-review                                           |
| `optional/design-review.md`    | `.claude/fwd/design-review.md`       | design-review                                              |
| `optional/caching.md`          | `.claude/fwd/caching.md`             | caching                                                    |

`fwd.json` leaves out `featureAcceptance.signIn` and `themes`: an empty value changes what the
tools do, so add them only when the project has signed-in routes or themes. Delete the
`featureAcceptance` block, `uiSweep` and `neon` if the project has no UI, no sweep or no Neon
branch to protect.
