# Secrets inventory

Every secret this app uses, by NAME. **Never write a value here**, not even a partial one, a prefix
or an example. This file is safe to commit because it holds names only.

Update it in the same PR that adds, moves, renames or removes a secret.

## Where a secret can live

- **Vercel:** the project name and each environment it is set in (Production, Preview,
  Development). Say whether it is marked Sensitive.
- **GitHub Actions:** a repository secret or a repository variable, and the workflow that reads it.
- **Local:** `.env.local` on a developer's machine. Never committed.

## Inventory

| Name           | Where it lives                                                 | Read by                          | Rotation owner |
| -------------- | -------------------------------------------------------------- | -------------------------------- | -------------- |
| `DATABASE_URL` | Vercel `<project>`: Production (Sensitive); local `.env.local` | the app's database client        | owner          |
| `SENTRY_DSN`   | Vercel `<project>`: Production (Sensitive)                     | `instrumentation.ts`             | owner          |
| `<NAME>`       | GitHub Actions secret, read by `.github/workflows/<workflow>`  | `<script or step that reads it>` | `<who>`        |

## When a secret rotates

1. Find its row above and every place it lives.
2. The rotation owner sets the new value in each place by hand.
3. Redeploy whatever reads it, then confirm it works.
4. Change this file only if a name or a location changed.
