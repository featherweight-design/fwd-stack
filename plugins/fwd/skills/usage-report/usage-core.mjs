// The weekly-allowance split, from Claude Code's local transcripts. Pure: reading files is
// usage-report.mjs's job. Anthropic does not publish how the weekly limit is computed, so turns are
// weighted the way API prices relate (input 1, cache write 1.25, cache read 0.1, output 5). The
// result is a proxy for shares, not the meter: `/usage` shows the meter.

export const WEIGHT = { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 };

export function weigh(u = {}) {
  return (
    (u.input_tokens ?? 0) * WEIGHT.input +
    (u.cache_creation_input_tokens ?? 0) * WEIGHT.cacheWrite +
    (u.cache_read_input_tokens ?? 0) * WEIGHT.cacheRead +
    (u.output_tokens ?? 0) * WEIGHT.output
  );
}

// A worktree counts as its repository: `<repo>/.worktrees/<b>` and `<repo>/.claude/worktrees/<b>`.
export function projectOf(cwd = '', home = '') {
  let p = cwd
    .replace(/\/\.claude\/worktrees\/[^/]+.*$/, '')
    .replace(/\/\.worktrees\/[^/]+.*$/, '');
  if (home && p.startsWith(home)) p = '~' + p.slice(home.length);
  return p || '?';
}

const context = (u = {}) =>
  (u.input_tokens ?? 0) +
  (u.cache_read_input_tokens ?? 0) +
  (u.cache_creation_input_tokens ?? 0);

/**
 * Folds transcript lines into totals. Each assistant turn counts once (a turn is written as
 * several lines, one per content block). `since` is a ms timestamp; older turns are skipped.
 */
export function tally(
  lines,
  { since = 0, home = '', resolve = (c) => c } = {},
  acc = newTally(),
) {
  for (const line of lines) {
    if (
      !line.includes('"assistant"') &&
      !line.includes('agent-name') &&
      !line.includes('custom-title')
    )
      continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    // An agent name wins over any title; among titles the latest wins, so a renamed session shows
    // its current name.
    if (e.type === 'agent-name' && e.agentName) {
      acc.names.set(e.sessionId, e.agentName);
      acc.agentNamed.add(e.sessionId);
    }
    if (
      e.type === 'custom-title' &&
      e.customTitle &&
      !acc.agentNamed.has(e.sessionId)
    )
      acc.names.set(e.sessionId, e.customTitle);
    if (e.type !== 'assistant' || !e.message?.usage) continue;
    // A turn is written as several lines, one per content block, and a later line can carry a
    // larger output count than the first. Each turn counts once, at its largest reading: a repeat
    // adds only what it raises the turn by.
    const key = `${e.message.id}:${e.requestId ?? ''}`;
    if (Date.parse(e.timestamp) < since) continue;
    const full = weigh(e.message.usage);
    const before = acc.seen.get(key);
    if (before !== undefined && full <= before) continue;
    acc.seen.set(key, full);
    const w = full - (before ?? 0);
    const first = before === undefined;
    const project = projectOf(resolve(e.cwd ?? ''), home);
    const model = (e.message.model ?? '?').replace(/^claude-/, '');
    const side = e.isSidechain ? 'subagent' : 'main';
    acc.total += w;
    add(acc.byProject, project, w);
    add(acc.byModel, model, w);
    add(acc.bySide, side, w);
    add(acc.byDay, (e.timestamp ?? '').slice(0, 10), w);
    const s = acc.sessions.get(e.sessionId) ?? {
      projects: new Map(),
      weight: 0,
      turns: 0,
      contexts: [],
    };
    s.weight += w;
    add(s.projects, project, w);
    if (!e.isSidechain && first) {
      s.turns += 1;
      s.contexts.push(context(e.message.usage));
    }
    acc.sessions.set(e.sessionId, s);
  }
  return acc;
}

export const newTally = () => ({
  total: 0,
  seen: new Map(),
  names: new Map(),
  agentNamed: new Set(),
  sessions: new Map(),
  byProject: new Map(),
  byModel: new Map(),
  bySide: new Map(),
  byDay: new Map(),
});

const add = (m, k, v) => m.set(k, (m.get(k) ?? 0) + v);
const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const pct = (v, t) => `${t ? Math.round((1000 * v) / t) / 10 : 0}%`;
const k = (n) => `${Math.round(n / 1000)}k`;

export function render(acc, { days, top = 10 } = {}) {
  const rank = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);
  const lines = [
    `# Claude Code usage, last ${days} days`,
    '',
    'Shares of a weighted token count (input 1, cache write 1.25, cache read 0.1, output 5): a proxy for the weekly allowance, not the meter. Claude Design and claude.ai chat draw on the same allowance and leave no local log, so their use is not observed here; `/usage` shows the meter, which this cannot be subtracted from.',
    '',
    '| Project | Share |',
    '| --- | --- |',
    ...(() => {
      // Projects under half a percent fold into one row, so the table stays readable.
      const rows = rank(acc.byProject);
      const big = rows.filter(([, w]) => w >= acc.total * 0.005);
      const small = rows.filter(([, w]) => w < acc.total * 0.005);
      const out = big.map(([p, w]) => `| ${p} | ${pct(w, acc.total)} |`);
      if (small.length)
        out.push(
          `| ${small.length} others | ${pct(
            small.reduce((a, [, w]) => a + w, 0),
            acc.total,
          )} |`,
        );
      return out;
    })(),
    '',
    `**Models:** ${rank(acc.byModel)
      .map(([m, w]) => `${m} ${pct(w, acc.total)}`)
      .join(' · ')}`,
    `**Main sessions vs subagents:** ${rank(acc.bySide)
      .map(([s, w]) => `${s} ${pct(w, acc.total)}`)
      .join(' · ')}`,
    `**By day:** ${[...acc.byDay.entries()]
      .sort()
      .map(([d, w]) => `${d.slice(5)} ${pct(w, acc.total)}`)
      .join(' · ')}`,
    '',
    `## Costliest sessions`,
    '',
    '| Session | Project | Share | Turns | Median context | Max context |',
    '| --- | --- | --- | --- | --- | --- |',
    ...[...acc.sessions.entries()]
      .sort((a, b) => b[1].weight - a[1].weight)
      .slice(0, top)
      .map(
        ([id, s]) =>
          `| ${acc.names.get(id) ?? id.slice(0, 8)} | ${s.projects.size > 1 ? `${rank(s.projects)[0][0]} (+${s.projects.size - 1})` : rank(s.projects)[0][0]} | ${pct(s.weight, acc.total)} | ${s.turns} | ${k(median(s.contexts))} | ${k(Math.max(0, ...s.contexts))} |`,
      ),
    '',
    'A long session at a large context is the usual cost: every turn re-reads all of it. Rotate lanes at `rotateAt` while the user is present, start fresh sessions per PR or two, and put routine lane work on Sonnet.',
  ];
  return lines.join('\n') + '\n';
}
