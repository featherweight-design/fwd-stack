---
name: caching
description: Use when a page or API feels slow, when adding or changing any read path, cache, revalidation, Cache-Control header, client query cache or service worker, and when reviewing a PR that touches one. The standard caching approach for a Next.js App Router project on Vercel with Postgres: what may be cached where, how keys are versioned so they retire themselves, where invalidation lives, and how to measure before and after.
---

# caching

One caching approach for every project. The aim is fast first loads without ever serving one
person's data to another, and without relying on someone remembering to invalidate.

**First, read the project's own rules.** If `.claude/fwd/caching.md` exists in the project, read
it before anything else. It names the project's cache helpers, its data-generation stamp, its
revalidate route and its measuring commands, and wins where it conflicts with this skill.

## 0 · Measure first

A slow page is a claim until it is measured. Before changing anything, and again after:

- **Server time per route.** A server-timing log around each read, behind an env switch (for
  example `PERF_TIMING=1`), so the slow read is named rather than guessed.
- **First and repeat load** of the 3 to 5 heaviest routes: TTFB and LCP, plus the
  `x-vercel-cache` and `Cache-Control` each response carries.
- **API tail latency,** not only the median. A page that fans out to several calls waits for the
  slowest one, so a p95 of a few hundred milliseconds sets the page's floor.
- **Calls on mount.** Count the client requests a page fires as it loads. The same resource
  fetched twice is a bug, not a cache problem.

Check region placement once: the app's functions should run in the same region as the database.

## 1 · Public or personal

Split every read before caching it.

- **Public:** the same answer for everyone (a catalog, a listing, a landing count). Only public
  reads may enter a shared cache.
- **Personal:** depends on who is asking. It is never cached across users. If it is cached at
  all, it is per user, under a key that includes the user id, and tagged so the user's own writes
  retire it.

When unsure, it is personal.

## 2 · Cache public reads on the server

The server's data cache helps the very first visit, which no browser cache can.

- Use the framework's data cache: `'use cache'`, `unstable_cache`, or
  `fetch(…, { next: { revalidate, tags } })`.
- Wrap it in one project helper that **stores only good answers.** A not-found or failed read is
  served, but never stored, so one bad moment is not pinned for hours.
- Avoid an internal HTTP hop where the page could read the data directly. Each hop adds its own
  latency and tail. Where a separate API is the architecture, cache its public reads at the
  calling server (or at the CDN, §5).
- Dedupe within a request with React `cache()`.
- Reuse one database pool per process. A fresh pool per request costs far more than a warm one.

## 3 · Version the keys

Tags and time limits are a backstop, not the main mechanism. Every cache key carries:

- **A data generation stamp.** The ingest or crawl job bumps it when it finishes; reads see it
  through a short cache (about 60 seconds). A new generation retires every entry without
  anyone listing what to invalidate. If the stamp cannot be read, fall back to a fixed value
  rather than failing the read.
- **The deployment id,** so a new build never serves the previous build's payload shape.
- **The local date,** for anything relative to "today".

Then a long ceiling (1 to 24 hours) and tags, for the case where a stamp is missed.

**Advanced tier, after public caching is in and measured:** a per-user data stamp, kept by the
database (bumped at commit by a trigger on every per-user table), in the key of a per-user page
cache. That makes per-user invalidation correct by construction. Ship it behind a switch, with a
runbook, and turn it on in staging first.

## 4 · Invalidate at the writer

- The ingest job ends by bumping the generation and, where needed, calling a token-gated revalidate
  route.
- A server action whose user must see their own write uses `updateTag`, which reads through.
  `revalidateTag` serves stale once, which is wrong for read-your-writes.

## 5 · HTTP headers

For a public API that a CDN can cache:

- Anonymous GET of public data: `public, s-maxage=<N>, stale-while-revalidate=<M>` with
  `Vary: Authorization`.
- Any authenticated or personal response: `private, no-store`.
- Never default catalog data to `max-age=0`.

A request carrying an `Authorization` header bypasses the CDN cache, so client calls for public
data should not send one.

## 6 · Client

- One query per resource, under a shared key. Three components fetching the current user is
  three round trips; fetch it once and pass it down or share the query.
- A sensible default `staleTime` for a query library, or component-held caches keyed by the
  parameters, for list views a reader flips between.
- **Never `experimental.staleTimes`.** It is router-wide and has caused stale-page bugs.
- `prefetch={false}` on heavy or low-value links.

## 7 · Service worker

- CacheFirst for hashed static assets (`/_next/static/`).
- NetworkFirst or an offline fallback for pages and data.
- Never cache a credentialed request.

## 8 · Third-party scripts

Pin exact versions. A script loaded by major tag answers with an uncacheable redirect on every
load, which costs a round trip or two before anything runs, and more on a slow phone.

## 9 · Review checklist

A PR that touches a read path, cache or header passes only if:

- No personal data can enter a shared cache, and every per-user key includes the user id.
- Failed and not-found reads are not stored.
- Keys carry the generation stamp and deployment id; a "today" read carries the date.
- The writer invalidates (stamp bump, revalidate call or `updateTag`).
- Headers match §5.
- Before-and-after measurements from §0 are in the PR body.
