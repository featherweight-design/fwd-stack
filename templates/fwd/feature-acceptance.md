<!--
  Read first by the feature-acceptance skill, which stops without this file. Fill in each
  <placeholder>. Tool settings live in the featureAcceptance block of .claude/fwd.json.
-->

# Feature acceptance rules

- **Widths:** phone 390 x 844, desktop 1300 x 900 (the `widths` in `.claude/fwd.json`).
- **Inventories:** `docs/inventories/`, one JSON file per feature.
- **Sign-in:** <how the test account is provisioned, with the names of the environment variables,
  never values; or "none: every route is signed out", and set `"signedOut": true` in each inventory.>
- **Development env in worktrees:** <may lanes run the app with the development env in their
  worktree? Name the env file, never its values. Record the user's yes or no here.>
- **Token guard:** <component folders `check-tokens` covers, or "none".>
- **App shell:** <anything in the shell a step must avoid, or "none".>
- **Contact sheet:** attach it to the PR description under `## Contact sheet`.

## Stub route inventory

Copy to `docs/inventories/<feature>.json`: one row per route the feature claims.

```json
{
  "feature": "<feature name>",
  "signedOut": true,
  "rows": [
    {
      "id": "home",
      "label": "/ at rest",
      "steps": [
        { "goto": "/", "wait": "<a data-testid or text the finished page has>" }
      ]
    }
  ]
}
```
