# fwd-stack: agent notes

The shared configs, CI gate and version baseline for the owner's apps.

- pnpm only. Gate before every push: `pnpm format:check && pnpm typecheck && pnpm lint`. No tests
  locally; CI is the only test gate (`pr-review` skill, §3).
- Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`, `perf:`, `ci:`).
- Never commit to `main`; every change is a PR. Review cycles and the merge bar follow the
  `pr-review` skill; run its gate (`plugins/fwd/skills/pr-review/pr-gate.mjs`) rather than
  recalling the state.
- `plugins/fwd` is public. Never put private repositories' code, finding text, PR numbers or costs
  in it; skill state belongs in the plugin's data folder.
- A change here reaches every project that extends it. Before changing a shared rule or option,
  check what it does to every app, and land their fixes alongside.
- Project-specific rules (an app's copy lint, an app's hover-state guard) stay in those
  projects, layered after the shared config. Only what the apps share belongs here.
- `baseline.json` is the source of truth for version majors; raise it first, then each project.
