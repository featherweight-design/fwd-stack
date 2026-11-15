# Monitoring spec

The file `monitoring-apply.mjs` reads. One per app, kept in the app's own repo at
`.claude/fwd/monitoring.json`. [`monitoring.example.json`](monitoring.example.json) is a complete,
fictional example. Every section is optional; leave a vendor out and the tool never calls it.

The spec holds names and ids, never a token. Tokens come from the environment (see SKILL.md).

## Top level

| Key           | Type   | Notes                                             |
| ------------- | ------ | ------------------------------------------------- |
| `app`         | string | Optional label for people reading the file.       |
| `sentry`      | object | Organization dashboards.                          |
| `posthog`     | object | Saved insights and the dashboards that hold them. |
| `betterstack` | object | Better Stack Uptime heartbeats and status pages.  |

## `sentry`

| Key          | Type   | Notes                                                                |
| ------------ | ------ | -------------------------------------------------------------------- |
| `org`        | string | Required. The organization slug.                                     |
| `host`       | string | Default `https://sentry.io`. Use the region host if the org has one. |
| `dashboards` | array  | Matched by `title`.                                                  |

A dashboard takes `title` (required), and optionally `projects` (numeric project ids),
`environment`, `period` (such as `14d`), `filters`, `utc` and `widgets`.

A widget is matched by `title` inside its dashboard and is sent as written, in Sentry's own
shape: `displayType` (`line`, `area`, `bar`, `table`, `big_number`, `top_n`), `widgetType`
(`error-events`, `issue`, `spans`, `transaction-like` and so on), optional `interval`, `limit` and
`layout`, and `queries`, each with `name`, `fields`, `aggregates`, `columns`, `conditions` and
`orderby`. The easiest way to get a widget right is to build it once in the UI, read it back with
`GET /api/0/organizations/{org}/dashboards/{id}/`, and copy the widget into the spec.

On update the tool sends the whole widget list, because that is how Sentry's edit endpoint works.
Widgets on the dashboard that the spec does not name are sent back unchanged, so they stay.

## `posthog`

| Key          | Type   | Notes                                                              |
| ------------ | ------ | ------------------------------------------------------------------ |
| `projectId`  | number | Required. The project id from the project settings URL.            |
| `host`       | string | Default `https://us.posthog.com`; `https://eu.posthog.com` for EU. |
| `insights`   | array  | Matched by `name`, among saved insights that are not deleted.      |
| `dashboards` | array  | Matched by `name`, among dashboards that are not deleted.          |

An insight takes `name` and `query` (required), and optionally `description` and `tags`. `query`
is PostHog's query JSON, usually an `InsightVizNode` whose `source` is a `TrendsQuery` or a
`FunnelsQuery` with a `series` of `EventsNode`s. Fields PostHog adds when it saves the query are
ignored when comparing.

A dashboard takes `name` (required), optionally `description`, `tags` and `pinned`, and
`insights`: the names of insights from this spec to show on it. Tiles are only ever added; a tile
already on the dashboard that the spec does not name stays.

## `betterstack`

| Key           | Type   | Notes                                                    |
| ------------- | ------ | -------------------------------------------------------- |
| `host`        | string | Default `https://incidents.betterstack.com`.             |
| `heartbeats`  | array  | Matched by `name`.                                       |
| `statusPages` | array  | Matched by `subdomain`, which Better Stack keeps unique. |

A heartbeat is sent as written: `name`, `period` and `grace` (seconds; period at least 30) are
required, and the API's other fields (`email`, `sms`, `call`, `push`, `team_wait`, `policy_id`,
`paused`, and `team_name` with a global token) are optional.

A status page is sent as written, without its `resources`: `subdomain`, `company_name` and
`timezone` are required, and any other field of the status-pages API (`company_url`, `history`,
`published`, `design`, `theme` and so on) is optional.

A status page's `resources` are matched by `public_name` within the page. Each names exactly one
of:

- `monitor`: an existing monitor's name (its `pronounceable_name`) or its numeric id;
- `heartbeat`: a heartbeat's name or numeric id, including one this spec creates.

and optionally `widget_type`, `explanation`, `position`, `status_page_section_id` and the other
fields of the resources API. A name that matches no monitor or heartbeat, or several, is skipped
with a note.

## Matching rules, all vendors

- An object is unchanged when every field the spec states equals the live value. Fields the spec
  leaves out are not compared and not sent. A field the vendor never reads back (a status page
  `password`, say) shows as an update on every run, so set it by hand instead.
- When two live objects share a spec name, the tool skips that object with a note rather than
  guess. Rename one by hand, then re-run.
- Nothing is ever deleted. To remove an object, delete it in the vendor's console and take it out
  of the spec.
