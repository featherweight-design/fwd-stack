#!/usr/bin/env node
// The weekly escape sweep (SKILL.md, "Escapes are tracked four ways", items 1 and 2).
//
//   node escape-sweep.mjs --repo owner/name [--repo ...] --since YYYY-MM-DD [--json]
//
// For each repo it lists the PRs merged into main since the date and reports:
//  1. named escapes: fix PRs whose body says `## Escaped from #N` (or a bare `Escaped from #N`
//     line), with whether #N was risky;
//  2. candidates: PRs titled fix/revert/hotfix that touch a file a risky PR changed in the 14
//     days before the candidate merged, and that no `Escaped from` line already names.
//
// Risk is read the way the gate reads it (riskyPathsOf and riskOverride, risk-override.mjs), from
// the PR's files, never from body text: an earlier ad-hoc sweep that judged risk by the words in a
// PR body flagged about 60 design-polish PRs. The files come from the same REST endpoint the gate
// reads, so a rename out of a risky path counts and a version-only manifest bump does not. Two gate
// signals are not read, because each needs more than the file list: a destructive diff (the gate's
// DESTRUCTIVE regex over added lines; a migration path is risky by path anyway) and a comment-only
// edit to a risky file (which needs the head file's text). So a PR risky only by a destructive call
// in an ordinary file is missed, and a comment-only edit to a risky file is counted.
//
// Read-only. The pure logic below takes plain data and is tested in escape-sweep.test.mjs; the gh
// calls sit in the thin layer at the bottom, which runs only when this file is executed.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  isDoc,
  isGenerated,
  isHandoff,
  isVersionOnlyChange,
} from './classify.mjs';
import { riskOverride, riskyPathsOf } from './risk-override.mjs';

const DAY = 24 * 60 * 60 * 1000;
export const WINDOW_DAYS = 14;
export const TITLE_WIDTH = 70;

const USAGE =
  'usage: node escape-sweep.mjs --repo owner/name [--repo ...] --since YYYY-MM-DD [--json]';

/** `{ repos, since, json }` from argv (without node and the script), or throws with the usage. */
export function parseArgs(argv) {
  const repos = [];
  let since = null;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--repo' || a === '--since') {
      const v = argv[++i];
      if (!v || v.startsWith('--'))
        throw new Error(`${a} needs a value\n${USAGE}`);
      if (a === '--repo') repos.push(v);
      else since = v;
    } else throw new Error(`unknown argument: ${a}\n${USAGE}`);
  }
  if (repos.length === 0) throw new Error(`--repo is required\n${USAGE}`);
  for (const r of repos)
    if (!/^[\w.-]+\/[\w.-]+$/.test(r))
      throw new Error(`--repo must be owner/name, got ${r}\n${USAGE}`);
  if (
    !since ||
    !/^\d{4}-\d{2}-\d{2}$/.test(since) ||
    Number.isNaN(Date.parse(since))
  )
    throw new Error(`--since must be YYYY-MM-DD\n${USAGE}`);
  return { repos, since, json };
}

/** The source PR numbers a body names under `## Escaped from #N` or a bare `Escaped from #N` line. */
export function escapedFrom(body) {
  const out = [];
  for (const m of String(body ?? '').matchAll(
    /^[ \t]*(?:#{1,6}[ \t]+)?Escaped from #(\d+)\b/gim,
  )) {
    const n = Number(m[1]);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** A conventional-commit fix, revert or hotfix title (any scope, optional `!`), or GitHub's `Revert "..."`. */
export const isFixTitle = (title) =>
  /^(fix|revert|hotfix)(\([^)]*\))?!?:/i.test(String(title ?? '').trim()) ||
  /^Revert "/.test(String(title ?? '').trim());

// A file as the REST files endpoint returns it (`{ filename, previous_filename?, status?, patch? }`),
// or a bare path.
const fileOf = (f) => (typeof f === 'string' ? { filename: f } : f);

// The files the gate proves non-runtime without the head file's text: a top-level version bump.
const nonRuntimeOf = (files) =>
  new Set(files.filter((f) => isVersionOnlyChange(f)).map((f) => f.filename));

/** Whether the gate would call this PR risky, from its paths and its `## Risk: not risky` section. */
export function riskOf(pr) {
  const files = pr.files.map(fileOf);
  const riskyPaths = riskyPathsOf(files, nonRuntimeOf(files));
  const override = riskOverride(pr.body ?? '', {
    riskyPaths,
    destructive: false,
  });
  return {
    risky: riskyPaths.length > 0 && !override.applied,
    riskyPaths,
  };
}

// Paths whose overlap says nothing about an escape: prose, tests, generated files and lockfiles,
// and design handoff. A candidate's version-only manifest bump is dropped separately (sweepRepo).
export const overlapIgnored = (p) =>
  isDoc(p) ||
  isGenerated(p) ||
  isHandoff(p) ||
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) ||
  /(^|\/)(__tests__|tests?|e2e|fixtures?)\//.test(p);

/** Source numbers a list of PRs names but does not contain: the thin layer fetches these. */
export function missingSources(prs) {
  const have = new Set(prs.map((p) => p.number));
  return [...new Set(prs.flatMap((p) => escapedFrom(p.body)))].filter(
    (n) => !have.has(n),
  );
}

/**
 * One repo's sweep. `prs` are the PRs merged into main from `since` minus the window (so a risky PR
 * just before `since` still counts as a source), each `{ number, title, body, files, mergedAt }`.
 * `extra` holds source PRs fetched outside that list, the same shape (files may be missing when the
 * source could not be fetched; it then reads `risky: null`).
 */
export function sweepRepo({ prs, since, extra = [] }) {
  const sinceMs = Date.parse(since);
  const byNumber = new Map([...extra, ...prs].map((p) => [p.number, p]));
  const risk = new Map();
  const riskFor = (p) => {
    if (!risk.has(p.number)) risk.set(p.number, riskOf(p));
    return risk.get(p.number);
  };
  const landed = prs
    .filter((p) => Date.parse(p.mergedAt) >= sinceMs)
    .sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt));
  const riskyPrs = prs.filter((p) => riskFor(p).risky);

  const named = [];
  for (const p of landed) {
    const sources = escapedFrom(p.body);
    if (sources.length === 0) continue;
    named.push({
      number: p.number,
      title: p.title,
      sources: sources.map((n) => {
        const src = byNumber.get(n);
        return {
          number: n,
          risky: src && Array.isArray(src.files) ? riskFor(src).risky : null,
        };
      }),
    });
  }
  const namedSet = new Set(named.map((n) => n.number));

  const candidates = [];
  for (const p of landed) {
    if (namedSet.has(p.number) || !isFixTitle(p.title)) continue;
    const at = Date.parse(p.mergedAt);
    const own = p.files.map(fileOf);
    const bumps = nonRuntimeOf(own);
    const mine = new Set(
      own
        .map((f) => f.filename)
        .filter((f) => !overlapIgnored(f) && !bumps.has(f)),
    );
    const sources = [];
    for (const r of riskyPrs) {
      const rAt = Date.parse(r.mergedAt);
      if (r.number === p.number || rAt >= at || rAt < at - WINDOW_DAYS * DAY)
        continue;
      const files = r.files
        .map((f) => fileOf(f).filename)
        .filter((f) => mine.has(f));
      if (files.length > 0) sources.push({ number: r.number, files });
    }
    if (sources.length > 0)
      candidates.push({ number: p.number, title: p.title, sources });
  }

  return {
    riskyLanded: landed.filter((p) => riskFor(p).risky).length,
    named,
    candidates,
  };
}

export const truncate = (s, width = TITLE_WIDTH) =>
  s.length <= width ? s : `${s.slice(0, width - 3)}...`;

function table(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  const line = (cells) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i])))
      .join('  ')
      .trimEnd();
  return [
    line(headers),
    line(widths.map((w) => '-'.repeat(w))),
    ...rows.map(line),
  ].join('\n');
}

/** The plain-text report: per repo, named escapes and candidates, then totals. */
export function formatReport(results, since) {
  const out = [`Escape sweep since ${since}`];
  const totals = { riskyLanded: 0, named: 0, candidates: 0 };
  for (const r of results) {
    totals.riskyLanded += r.riskyLanded;
    totals.named += r.named.length;
    totals.candidates += r.candidates.length;
    const riskWord = (v) =>
      v === null ? 'unknown' : v ? 'risky' : 'not risky';
    const rows = [
      ...r.named.map((n) => [
        `#${n.number}`,
        truncate(n.title),
        n.sources.map((s) => `#${s.number} (${riskWord(s.risky)})`).join(', '),
        'named escape',
      ]),
      ...r.candidates.map((c) => [
        `#${c.number}`,
        truncate(c.title),
        c.sources.map((s) => `#${s.number}`).join(', '),
        [...new Set(c.sources.flatMap((s) => s.files))].join(', '),
      ]),
    ];
    out.push(
      '',
      `${r.repo}: ${r.riskyLanded} risky PR(s) landed, ${r.named.length} named escape(s), ${r.candidates.length} candidate(s)`,
    );
    out.push(
      rows.length === 0
        ? '(none)'
        : table(
            ['Fix PR', 'Title', 'Source PR(s)', 'Overlapping risky file(s)'],
            rows,
          ),
    );
  }
  out.push(
    '',
    `Totals: ${totals.riskyLanded} risky PR(s) landed, ${totals.named} named escape(s), ${totals.candidates} candidate(s)`,
  );
  return out.join('\n');
}

// ---- thin gh layer -----------------------------------------------------------

const gh = (args) =>
  JSON.parse(
    execFileSync('gh', args, {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    }),
  );

// Every file of one PR from the REST endpoint the gate reads: it carries `previous_filename` for a
// rename and the patch, and has no per-PR cap below GitHub's own 3000 files.
const filesOf = (repo, n) =>
  execFileSync(
    'gh',
    [
      'api',
      '--paginate',
      `repos/${repo}/pulls/${n}/files`,
      '--jq',
      '.[] | {filename, previous_filename, status, patch}',
    ],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  )
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

const LIST_LIMIT = 1000;
const FIELDS = 'number,title,body,mergedAt';

const toPr = (repo, p) => ({
  number: p.number,
  title: p.title,
  body: p.body ?? '',
  files: filesOf(repo, p.number),
  mergedAt: p.mergedAt,
});

function fetchRepo(repo, since) {
  const from = new Date(Date.parse(since) - WINDOW_DAYS * DAY)
    .toISOString()
    .slice(0, 10);
  const listed = gh([
    'pr',
    'list',
    '--repo',
    repo,
    '--state',
    'merged',
    '--base',
    'main',
    '--search',
    `merged:>=${from}`,
    '--limit',
    String(LIST_LIMIT),
    '--json',
    FIELDS,
  ]);
  if (listed.length >= LIST_LIMIT)
    console.error(
      `warning: ${repo} returned ${LIST_LIMIT} PRs, the list cap; the oldest are missing. Use a later --since.`,
    );
  const prs = listed.map((p) => toPr(repo, p));
  const extra = [];
  for (const n of missingSources(prs)) {
    try {
      extra.push(
        toPr(
          repo,
          gh(['pr', 'view', String(n), '--repo', repo, '--json', FIELDS]),
        ),
      );
    } catch {
      extra.push({ number: n, title: '', body: '', mergedAt: null });
    }
  }
  return { repo, ...sweepRepo({ prs, since, extra }) };
}

// Run only when executed, not when the test imports it. Both sides are real paths, so a symlinked
// invocation still runs.
const executed = (() => {
  try {
    return (
      Boolean(process.argv[1]) &&
      realpathSync(process.argv[1]) ===
        realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
})();

if (executed) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const results = args.repos.map((r) => fetchRepo(r, args.since));
  if (args.json) {
    const totals = {
      riskyLanded: results.reduce((t, r) => t + r.riskyLanded, 0),
      named: results.reduce((t, r) => t + r.named.length, 0),
      candidates: results.reduce((t, r) => t + r.candidates.length, 0),
    };
    console.log(
      JSON.stringify({ since: args.since, repos: results, totals }, null, 2),
    );
  } else console.log(formatReport(results, args.since));
}
