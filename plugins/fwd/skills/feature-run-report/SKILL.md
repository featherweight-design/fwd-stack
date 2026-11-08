---
name: feature-run-report
description: Use at the end of an autonomous multi-PR run (epic-run, an orchestrator's overnight run, any long PR sequence) to email the user a run report they read on their phone, and mid-run the moment the run blocks on a decision only the user can make. Builds the report as JSON and sends it with send-report.mjs, then pings the phone.
---

# feature-run-report

**First, read the project's own rules.** If `.claude/fwd/feature-run-report.md` exists in the project, read
it before anything else: it names the project's own tools and conventions for this skill, and
its rules add to these and win where they conflict.

The run report is an email the user reads on their phone. It answers three questions per project:
how far along is the work, what can I test now and how, and what is waiting on me. It replaces the
old in-transcript "Morning report"; that shape (PR table, Copilot callouts, checklist) is retired.

## When to send

- **End of a run:** the last PR of the run has merged, cleanup is done, and no more work is queued.
- **Mid-run, blocked:** the moment the run blocks on a decision only the user can make. Set
  `needsInput: true` (the subject then starts `[needs input]`), send, and keep working on anything
  unblocked.

**Not for:** single-PR sessions or check-ins between merges.

## The report JSON

Write one JSON file. Every field except `projects` is optional, and an epic needs `total`
(a positive whole number, at least `done + inProgress`); a bad count fails the send naming the epic.

```json
{
  "run": "Overnight run",
  "needsInput": false,
  "title": "🌙 Run update",
  "headsUp": [
    "Staging deploy failed twice; the lane rolled back and paused that line."
  ],
  "projects": [
    {
      "icon": "🧪",
      "name": "Sample App",
      "epics": [
        {
          "name": "Checkout, phase 2",
          "done": 8,
          "inProgress": 1,
          "total": 10,
          "unit": "PRs"
        }
      ],
      "also": "2 dependency updates, 1 bug fix",
      "ready": [
        {
          "what": "📈 Search filters",
          "how": "Open [the app](https://example.com) and filter by date."
        },
        { "what": "🧹 Formatter run", "change": "code" }
      ],
      "waiting": [
        {
          "decision": "**Auth upgrade**: accepts any token type",
          "pick": "Close; fix in the migration",
          "blocks": "Nothing else"
        },
        { "setup": "Update the plugin and restart the session" }
      ],
      "inProgress": ["SDK upgrade"]
    }
  ],
  "ideas": [{ "icon": "🧪", "text": "Enforce formatting in CI" }],
  "todo": { "url": "https://example.com/todo", "label": "Your to-do list" }
}
```

| Field                   | Meaning                                                                                                                                                                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run`                   | The run's name. Ends the subject; shown under the heading.                                                                                                                                                                                         |
| `needsInput`            | `true` when sent mid-run because blocked. Prefixes the subject with `[needs input]`.                                                                                                                                                               |
| `title`                 | Heading. Defaults to `🌙 Run update`, or `🙋 Run needs you` when `needsInput`.                                                                                                                                                                     |
| `headsUp`               | Lines for the 🚨 box: only when something went wrong (failed deploy, rollback, stalled lane). Omit otherwise.                                                                                                                                      |
| `projects[].epics`      | One bar per epic or phase. `done` merged, `inProgress` open, `total` planned, counted from the system of record the way the `progress-chart` skill counts (same rounding, 10 cells). `unit` defaults to `PRs`.                                     |
| `projects[].also`       | Work outside the epics, one line ("2 dependency updates, 0 bugs").                                                                                                                                                                                 |
| `projects[].ready`      | Shipped and testable. `what` plus `how` (URL, account, what to click, what you should see). For work with nothing to test, give `change` instead of `how`: `code`, `dependency`, `tooling` or `docs`.                                              |
| `projects[].waiting`    | Decisions only the user can make: `decision`, `pick` (your recommendation), `blocks` (what waits on it). A setup step the user must do (a key to add, a plugin to update) is `{ "setup": "..." }` and renders with 🔧.                             |
| `projects[].inProgress` | Open work, one short phrase each.                                                                                                                                                                                                                  |
| `ideas`                 | **Trial.** Ideas the run turned up, not yet ranked. Nothing starts until the user ranks them. Strings or `{ icon, text }`. Omit when none. A backlog audit's proposals stay in its own report; at most one line here or in `waiting` points to it. |
| `todo`                  | Footer link to the user's to-do page. Falls back to `REPORT_TODO_URL` in the config; omitted when neither is set.                                                                                                                                  |

Text fields take two pieces of markup, `**bold**` and `[text](https://url)`. Everything else is
escaped. Never put a secret value in any field; name the variable and where to set it.

## Section rules

- **Counts come from the data.** The three tiles (✅ ready, 🙋 need you, 🟡 in progress) and the
  subject are the totals of `ready`, `waiting` and `inProgress` across projects. Don't pad them.
- **One card per project that the run touched**, in the order the user cares about.
- **Empty boxes say so.** A project with nothing to test or nothing waiting shows "Nothing ready to
  test" / "Nothing waiting on you"; the renderer does this when the list is empty.
- **Heads up, ideas, epics, also and the to-do link are optional.** Leave them out when empty; the
  renderer then drops the section.
- **Sweep every PR in the run for setup the user owes.** New environment variables, new services
  (cron jobs, workers, queues, buckets), a plugin to update: each is a `setup` item naming where to
  do it, never the value. Say plainly when a service is only declared in the hosting config and not
  yet created at the provider ("declared only, not created"): a cron that was never created logs
  nothing and pages nobody. If a feature stays dormant until the step is done, say so.
- **Say what you did not validate.** If a flow can only be checked on the user's own device, the
  `how` says so.
- **Links are full URLs**, never a bare `#NNNN`.

## Wording

Plain and short. No cute language. The user reads this on a phone.

- Work with nothing to test says what it was: "Code improvement, no visible change",
  "Dependency update, no visible change", "Tooling change, no visible change". The `change` field
  produces exactly these; don't write your own variant, and never "Nothing to click".
- `how` is the steps, not a description of the feature.
- `pick` is a recommendation the user can accept in one word.

## Delivery

Writing the report is not delivering it. Never skip a step silently.

1. Write the JSON to a file in the session's scratch folder.
2. Send it: `node ~/.claude/fwd/lib/send-report.mjs --data <file>`. It prints `sent <id>`. The
   subject is built from the counts (`✅ 9 ready · 🙋 2 need you · <run>`, with `[needs input]` in
   front when blocked); pass `--subject` only to override it. The script reads `RESEND_API_KEY`,
   `EMAIL_FROM`, `REPORT_EMAIL_TO` and optionally `REPORT_TODO_URL` from the environment, or from
   `report-email.json` in the plugin data folder.
3. Ping the phone with `PushNotification`: the subject line. The email carries the detail.
4. If the send fails (missing config, Resend error), say so in the push and in the final message,
   and put the report's content in the transcript instead.

## Related

- `progress-chart`: the same counting rules, for status asked for in the session.
- `epic-run` and `orchestrator`: the callers. A run ends with this report.
