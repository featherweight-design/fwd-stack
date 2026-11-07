# fwd-stack

The shared stack for Featherweight projects (Concert Crawl, The 99 and whatever comes next): the
configs every project extends, the CI gate every project calls, and the version baseline every
project is held to.

The design and the reasoning behind it are in the
[audit and design doc](https://claude.ai/artifact/Tah89KVLvYZKj7cATrYzwZ).

## What is here

| Path                            | What it is                                                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `packages/tsconfig`             | `base`, `strictest`, `nextjs` and `node` TypeScript configs                                                                 |
| `packages/eslint-config`        | `base`, `node` and `next` ESLint flat configs                                                                               |
| `packages/prettier-config`      | The shared Prettier config                                                                                                  |
| `packages/commitlint-config`    | Conventional commits with the shared type list                                                                              |
| `.github/workflows/node-ci.yml` | Reusable CI gate: install, then typecheck, lint, test and build; opt-in selected tests with a nightly full run              |
| `baseline.json`                 | The majors every project is held to (Node, pnpm, Next, React, Zod, Vitest, Sentry, Drizzle …), plus a Node security minimum |
| `plugins/fwd`                   | Claude Code plugin: the shared agent skills and their guard hooks                                                           |
| `tests/`                        | Proves each config loads and enforces what it claims                                                                        |

Planned, in order: the `stack` generator with opt-in capabilities, `stack doctor` (drift against
`baseline.json`), and a cross-project cost check.

## Using it in a project

The packages are not on npm yet. Until they are, install them from this repo by path:

```sh
pnpm add -D "@fwd-stack/eslint-config@github:featherweight-design/fwd-stack#path:/packages/eslint-config"
```

TypeScript:

```json
{ "extends": "@fwd-stack/tsconfig/nextjs" }
```

ESLint (a project's own rules go after the shared ones):

```js
import next from '@fwd-stack/eslint-config/next';

export default [...next, { rules: {/* project guards */} }];
```

Prettier, in `package.json`: `"prettier": "@fwd-stack/prettier-config"`.

CI, in the project's `.github/workflows/ci.yml`:

```yaml
jobs:
  gate:
    uses: featherweight-design/fwd-stack/.github/workflows/node-ci.yml@main
    with:
      scripts: typecheck lint test build
```

### Selected tests on pull requests, the full suite nightly

This is optional, and off by default. A project whose suite is slow can run only the tests a change
needs on pull requests and pushes, and the whole suite on a schedule. Name a package.json script
that runs the selected tests:

```yaml
on:
  pull_request:
  push:
    branches: [main]
  # The full suite on main, nightly: the net under anything the selection missed.
  schedule:
    - cron: '17 9 * * *'
  workflow_dispatch:

jobs:
  gate:
    uses: featherweight-design/fwd-stack/.github/workflows/node-ci.yml@main
    with:
      scripts: typecheck lint test build
      selected-test-script: test:selected
```

With `selected-test-script` set, the step that would run `test` works like this:

- **Pull request.** Runs `test:selected` with `CI_BASE_REF` set to `origin/<base branch>`.
- **Push.** Runs `test:selected` with `CI_BASE_REF` set to the commit before the push. A new branch,
  or a forced push whose old head is gone, has no base to compare against, so it runs `test` in full.
- **Anything else** (the `schedule`, a `workflow_dispatch`). Runs `test` in full.

The checkout is then made with full history, so the base commit is there to compare against. The
selected script must exist: it runs without `--if-present`, so a misspelt name fails the job instead
of passing without running a test. With the input empty, the workflow runs exactly as it always has.

How a project selects is its own business. The script reads `CI_BASE_REF`. The simplest form is
Vitest's own. A change that touches no test, such as a README edit, selects none, and Vitest exits 1
on an empty run unless it is told not to:

```json
{
  "scripts": {
    "test:selected": "vitest run --changed \"$CI_BASE_REF\" --passWithNoTests"
  }
}
```

An import graph cannot see a test that reads files instead of importing them, such as a guard that
scans the source tree. A project with tests like that should add them to every selection, or have
its selector run the full suite when a shared config changes. The nightly run catches what the
selection missed, but only the next day.

#### When the nightly run goes red

A red nightly run has no pull request to block, so nobody sees it unless something reports it.
GitHub emails whoever last edited the schedule, and an orchestrator session never reads that email.
Two ways to put it where the orchestrator looks:

- **Check it on every status pass.** This prints the last scheduled run's result:

  ```sh
  gh run list --workflow ci.yml --event schedule --limit 1 \
    --json conclusion,url,createdAt
  ```

  A `failure` there is reported like any other red CI, and a lane is briefed to fix it before
  anything else merges.

- **Open an issue from the run.** Add this job beside `gate` in the caller. It opens one issue,
  labelled so the backlog shows it, and adds a comment for each later red night while it stays open:

  ```yaml
  nightly-red:
    needs: gate
    if: ${{ failure() && github.event_name == 'schedule' }}
    runs-on: ubuntu-latest
    permissions:
      issues: write
    steps:
      - env:
          GH_TOKEN: ${{ github.token }}
          GH_REPO: ${{ github.repository }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
        run: |
          open=$(gh issue list --label ci:nightly-red --state open \
            --json number --jq '.[0].number // empty')
          if [ -n "$open" ]; then
            gh issue comment "$open" --body "Failed again: $RUN_URL"
          else
            gh label create ci:nightly-red --color B60205 --force
            gh issue create --label ci:nightly-red \
              --title "Nightly full suite failed on $(date -u +%F)" \
              --body "The scheduled full test run failed: $RUN_URL"
          fi
  ```

  The orchestrator then finds it with `gh issue list --label ci:nightly-red`. Close the issue in the
  PR that fixes the failure.

## The Claude Code plugin

This repo is also a Claude Code plugin marketplace. The `fwd` plugin carries the skills and hooks
every project's agents share, so each repo runs the same review gate instead of its own copy.

```sh
/plugin install fwd --marketplace featherweight-design/fwd-stack
```

That one-step form needs Claude Code 2.1.275 or later. On an earlier version, add the
marketplace first:

```sh
/plugin marketplace add featherweight-design/fwd-stack
/plugin install fwd@fwd-stack
```

| Skill                | What it does                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| `pr-review`          | The Copilot review cycle and merge bar: the skill, its gate (`pr-gate.mjs`), watcher and hook                  |
| `feature-acceptance` | Proves a UI feature landed on every route and viewport it claimed                                              |
| `design-review`      | Compares an implementation against its design handoff, property by property                                    |
| `design-status`      | A fixed-shape readout of the design pipeline's state                                                           |
| `css-layout-triage`  | Measurement-first triage for layout bugs that resist fixing                                                    |
| `complete-and-ship`  | Finishes a plan's remaining tasks unattended, then opens and reviews the PR                                    |
| `epic-run`           | Runs a multi-PR feature epic end to end with per-PR and whole-vertical gates                                   |
| `feature-run-report` | The fixed-shape report at the end of an unattended run                                                         |
| `progress-chart`     | Status as a chart: one bar per named feature line from merged PRs, detail per group on request                 |
| `usage-report`       | Splits recorded Claude Code usage (weighted tokens) by project, model and session                              |
| `copy-review`        | Writing and reviewing customer-facing copy against the project's voice and locked vocabulary                   |
| `infra-setup`        | Hosting, database and monitoring defaults, staging footprint and a names-only secrets inventory                |
| `backlog-audit`      | Audits, triages and prioritises the GitHub Issues backlog, and governs intake                                  |
| `ui-audit`           | Runs the project's UI sweep, triages captures for layout breakage, files on approval                           |
| `prose-pass`         | Rewrites long-form in-app prose in the project's voice, with a fact check (own apps only)                      |
| `run-project`        | The standard operating model: one orchestrator, a capped set of lanes for PR work, subagents for bounded reads |
| `orchestrator`       | Coordinates lane sessions: assigns work, watches stalls and context, rotates lanes, reports status             |
| `lane`               | Works under an orchestrator: stays inside its brief, waits so the wait notifies, writes its handoff            |

Each skill first reads `.claude/fwd/<skill>.md` in the project, if present: the project's own
tools and rules for that skill, which win where they conflict. Settings the skills read (for
example `uiSweep`, `ownApp`) live in `.claude/fwd.json`.

State the skills keep, such as the pre-open pass ledger, lives in the plugin's data folder
(`~/.claude/plugins/data/fwd-fwd-stack/`), never in this repo.

### Setting up a machine

`machine/switch.sh` installs the plugin and makes the machine consistent. It works on a fresh
machine, on one that ran these skills from `~/.claude/skills`, and on one already switched (it
updates the plugin). Backups are kept in `~/.claude/backups/fwd-switchover-<time>/`:

```sh
machine/switch.sh --dry-run   # print every step, change nothing
machine/switch.sh             # back up, install, verify; rolls back on any failed check
machine/rollback.sh [backup]  # undo the last run, or the run whose backup folder you name
```

It does five things:

1. Installs `fwd@fwd-stack`.
2. Retires user-scope copies of the plugin's skills and hooks.
3. Carries the pre-open ledger into the data folder.
4. Links `~/.claude/fwd` to the plugin, so commands and docs outside a hook have a stable path,
   such as `node ~/.claude/fwd/skills/pr-review/pr-gate.mjs <pr>` or
   `node ~/.claude/fwd/hooks/autonomous-guard.mjs arm …`.
5. Points `~/.claude/CLAUDE.md` at that path.

`machine/verify.sh` checks that the guards answer as they should: the Neon guard, the merge
gate and the autonomous-run guard. Run the switch when no session is mid-review or mid-merge,
then restart sessions so they load the plugin's hooks.

**Shipping a plugin change to a machine.** Claude Code fetches a new copy only when
`plugins/fwd/.claude-plugin/plugin.json`'s `version` changes, so a merged change to the plugin
does nothing on a machine until that number is raised. Raise it in the change itself, or in a
follow-up PR, then run `machine/switch.sh` again: it updates the plugin, re-points
`~/.claude/fwd` at the new copy and verifies.

## Working on the kit

```sh
pnpm install
pnpm format:check && pnpm typecheck && pnpm lint
```

That is the whole local gate before a push. Tests run in CI only (the `pr-review` skill, §5).

Raising a version: change `baseline.json` first, then each project. A config change that would
fail an existing project lands with that project's fix PR linked in the description.
