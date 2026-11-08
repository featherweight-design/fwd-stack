#!/usr/bin/env node
// Email a run report through Resend, so a long run ends with a message the user reads on their
// phone rather than a transcript they must come back to the computer for. The orchestrator calls it
// as the last step of a run, and mid-run when the run blocks on a decision only the user can make.
//
//   node send-report.mjs --data <report.json> [--subject "<subject>"]
//
// The report is structured JSON (the shape is documented in the feature-run-report skill), rendered
// to email-safe HTML (tables and inline styles only) plus a plain-text fallback. With no --subject,
// the subject is built from the counts.
//
// Config is read from the environment, then from `report-email.json` in the plugin data folder:
// RESEND_API_KEY, EMAIL_FROM, REPORT_EMAIL_TO, and optionally REPORT_TODO_URL (the user's to-do
// page, linked in the footer when the report does not name one). Nothing is stored in the repository.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { cells } from '../skills/progress-chart/bar.mjs';
import { isMain } from './is-main.mjs';
import { pluginDataDir } from './plugin-data.mjs';

const KEYS = ['RESEND_API_KEY', 'EMAIL_FROM', 'REPORT_EMAIL_TO'];
const OPTIONAL_KEYS = ['REPORT_TODO_URL'];

export function loadConfig(env = process.env) {
  let file = {};
  try {
    file = JSON.parse(
      readFileSync(join(pluginDataDir(env), 'report-email.json'), 'utf8'),
    );
  } catch {
    // no file: the environment alone must carry the config
  }
  const config = Object.fromEntries(
    [...KEYS, ...OPTIONAL_KEYS].map((k) => [k, env[k] || file[k]]),
  );
  const missing = KEYS.filter((k) => !config[k]);
  if (missing.length) throw new Error(`missing config: ${missing.join(', ')}`);
  return config;
}

// What a shipped item with nothing to test was, said plainly.
export const NO_VISIBLE_CHANGE = {
  code: 'Code improvement, no visible change',
  dependency: 'Dependency update, no visible change',
  tooling: 'Tooling change, no visible change',
  docs: 'Documentation change, no visible change',
};

const C = {
  ink: '#172227',
  muted: '#5b6a71',
  rule: '#e3e8ea',
  border: '#dde4e7',
  head: '#eef3f5',
};

export const escapeHtml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const LINK = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;

// Text fields allow two pieces of markup, applied after escaping: [text](https://url) and **bold**.
const inline = (s) =>
  escapeHtml(s)
    .replace(LINK, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

const plain = (s) =>
  String(s ?? '')
    .replace(LINK, '$1 ($2)')
    .replace(/\*\*([^*]+)\*\*/g, '$1');

const list = (v) => (Array.isArray(v) ? v : []);

export function counts(report) {
  const projects = list(report.projects);
  const sum = (key) => projects.reduce((n, p) => n + list(p[key]).length, 0);
  return {
    ready: sum('ready'),
    waiting: sum('waiting'),
    inProgress: sum('inProgress'),
  };
}

export function subjectFor(report) {
  const n = counts(report);
  const parts = [`✅ ${n.ready} ready`, `🙋 ${n.waiting} need you`];
  if (report.run) parts.push(report.run);
  return `${report.needsInput ? '[needs input] ' : ''}${parts.join(' · ')}`;
}

// The 10-cell epic bar, counted the way the progress chart counts its 20-cell one.
export function epicBar({ done = 0, inProgress = 0, total }) {
  const [d, p, q] = cells(done, inProgress, total, 10);
  return '🟩'.repeat(d) + '🟨'.repeat(p) + '⬜'.repeat(q);
}

const epicCount = (e) =>
  `${e.done ?? 0} of ${e.total} ${e.unit ?? 'PRs'}${(e.done ?? 0) === e.total ? ' ✅' : ''}`;

const readyHow = (item) => {
  if (item.change) {
    const text = NO_VISIBLE_CHANGE[item.change];
    if (!text) throw new Error(`unknown change kind: ${item.change}`);
    return { text, muted: true };
  }
  return { text: item.how ?? '', muted: false };
};

const gap = '<div style="height:24px;line-height:24px">&nbsp;</div>';
const td = (style, body, colspan) =>
  `<td${colspan ? ` colspan="${colspan}"` : ''} style="${style}">${body}</td>`;
const cellStyle = 'padding:8px 10px;vertical-align:top';
const rowStyle = `border-top:1px solid ${C.rule}`;

function box({ title, tint, edge, head, rows, empty }) {
  const out = [
    `<table role="presentation" style="width:100%;border-collapse:collapse;background:${tint};border-left:4px solid ${edge};border-radius:6px">`,
    `<tr>${td('padding:8px 10px 4px;font-size:14px;font-weight:700', title, 3)}</tr>`,
  ];
  if (!rows.length) {
    out.push(
      `<tr>${td(`padding:4px 10px 8px;font-size:13px;color:${C.muted}`, empty, 3)}</tr>`,
    );
  } else {
    if (head) out.push(head);
    out.push(...rows);
  }
  out.push('</table>');
  return `<tr>${td('padding:6px 10px 10px', out.join(''), 2)}</tr>`;
}

const headRow = (labels) =>
  `<tr style="text-align:left;font-size:12px;color:${C.muted}">${labels
    .map(
      ([label, span]) =>
        `<th${span ? ` colspan="${span}"` : ''} style="padding:4px 10px">${escapeHtml(label)}</th>`,
    )
    .join('')}</tr>`;

function projectHtml(p) {
  const rows = [
    `<tr style="background:${C.head}">${td('padding:10px', `<strong style="font-size:17px">${escapeHtml([p.icon, p.name].filter(Boolean).join(' '))}</strong>`, 2)}</tr>`,
  ];
  for (const e of list(p.epics)) {
    rows.push(
      `<tr>${td(
        'padding:6px 10px 2px',
        `<div style="font-size:12px;color:${C.muted}">EPIC · ${escapeHtml(e.name)}</div><span style="white-space:nowrap">${epicBar(e)}</span> <span style="font-size:13px">${escapeHtml(epicCount(e))}</span>`,
        2,
      )}</tr>`,
    );
  }
  if (p.also) {
    rows.push(
      `<tr>${td(`padding:2px 10px 8px;font-size:12px;color:${C.muted}`, `➕ Also: ${inline(p.also)}`, 2)}</tr>`,
    );
  }
  rows.push(
    box({
      title: '✅ Ready to test',
      tint: '#eef8f1',
      edge: '#2f7d4f',
      head: headRow([['What'], ['How to test', 2]]),
      empty: 'Nothing ready to test',
      rows: list(p.ready).map((item) => {
        const how = readyHow(item);
        return `<tr style="${rowStyle}">${td(cellStyle, `<strong>${inline(item.what)}</strong>`)}${td(
          how.muted ? `${cellStyle};color:${C.muted}` : cellStyle,
          inline(how.text),
          2,
        )}</tr>`;
      }),
    }),
  );
  const waiting = list(p.waiting);
  rows.push(
    box({
      title: '🙋 Waiting on you',
      tint: '#fdf3ee',
      edge: '#b4441f',
      head: waiting.some((w) => !w.setup)
        ? headRow([['Decision'], ['My pick'], ['Blocks']])
        : '',
      empty: 'Nothing waiting on you',
      rows: waiting.map((w) =>
        w.setup
          ? `<tr style="${rowStyle}">${td(cellStyle, `<strong>🔧 Setup step:</strong> ${inline(w.setup)}`, 3)}</tr>`
          : `<tr style="${rowStyle}">${td(cellStyle, inline(w.decision))}${td(cellStyle, inline(w.pick))}${td(cellStyle, inline(w.blocks))}</tr>`,
      ),
    }),
  );
  const busy = list(p.inProgress);
  rows.push(
    `<tr>${td(
      'padding:0 10px 10px;font-size:13px',
      `🟡 <strong>In progress:</strong> ${busy.length ? busy.map(inline).join(' · ') : `<span style="color:${C.muted}">nothing</span>`}`,
      2,
    )}</tr>`,
  );
  return `<table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;border:1px solid ${C.border}">${rows.join('')}</table>`;
}

const idea = (i) =>
  typeof i === 'string' ? i : [i.icon, i.text].filter(Boolean).join(' ');

const todoLink = (report, config) => {
  const todo = report.todo ?? {};
  const url = todo.url ?? config.REPORT_TODO_URL;
  if (!url || !/^https?:\/\//.test(url)) return null;
  return { url, label: todo.label ?? 'To-do list' };
};

export function renderHtml(report, config = {}) {
  const n = counts(report);
  const tile = (bg, value, label, pad) =>
    `<td style="width:33%;${pad}"><div style="background:${bg};border-radius:8px;padding:10px;text-align:center"><div style="font-size:22px;font-weight:700">${value}</div><div style="font-size:12px">${label}</div></div></td>`;
  const out = [
    `<h1 style="font-size:22px;margin:0 0 10px">${escapeHtml(report.title ?? (report.needsInput ? '🙋 Run needs you' : '🌙 Run update'))}</h1>`,
  ];
  if (report.run) {
    out.push(
      `<p style="font-size:13px;color:${C.muted};margin:0 0 10px">${escapeHtml(report.run)}</p>`,
    );
  }
  out.push(
    `<table role="presentation" style="width:100%;border-collapse:collapse"><tr>${tile('#e8f5ec', n.ready, '✅ ready', 'padding-right:4px')}${tile('#fbece6', n.waiting, '🙋 need you', 'padding:0 2px')}${tile('#fff6d6', n.inProgress, '🟡 in progress', 'padding-left:4px')}</tr></table>`,
    gap,
  );
  const headsUp = list(report.headsUp);
  if (headsUp.length) {
    out.push(
      `<table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;background:#fff4f4;border-left:4px solid #c62828;border-radius:6px"><tr><td style="padding:10px"><strong>🚨 Heads up</strong><br>${headsUp.map(inline).join('<br>')}</td></tr></table>`,
      gap,
    );
  }
  for (const p of list(report.projects)) out.push(projectHtml(p), gap);
  const ideas = list(report.ideas);
  if (ideas.length) {
    out.push(
      `<table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;border:1px solid ${C.border}"><tr style="background:${C.head}"><td style="padding:10px"><strong style="font-size:16px">💡 New ideas to place</strong><br><span style="font-size:12px;color:${C.muted}">Found during the run; nothing starts until you rank them.</span></td></tr>${ideas
        .map(
          (i) =>
            `<tr style="${rowStyle}"><td style="${cellStyle}">${inline(idea(i))}</td></tr>`,
        )
        .join('')}</table>`,
    );
  }
  const todo = todoLink(report, config);
  out.push(
    `<p style="font-size:12px;color:${C.muted};margin-top:16px">🟩 done · 🟨 in progress · ⬜ queued · ➕ outside the epics${
      todo
        ? `<br>📋 <a href="${escapeHtml(todo.url)}">${escapeHtml(todo.label)}</a>`
        : ''
    }</p>`,
  );
  return `<div style="font-family:-apple-system,system-ui,sans-serif;max-width:600px;margin:0 auto;color:${C.ink};font-size:15px;line-height:1.45">${out.join('\n')}</div>`;
}

export function renderText(report, config = {}) {
  const n = counts(report);
  const out = [
    report.title ?? (report.needsInput ? 'Run needs you' : 'Run update'),
  ];
  if (report.run) out.push(report.run);
  out.push(
    '',
    `✅ ${n.ready} ready · 🙋 ${n.waiting} need you · 🟡 ${n.inProgress} in progress`,
  );
  const headsUp = list(report.headsUp);
  if (headsUp.length) {
    out.push('', '🚨 HEADS UP', ...headsUp.map((h) => `- ${plain(h)}`));
  }
  for (const p of list(report.projects)) {
    out.push('', `== ${[p.icon, p.name].filter(Boolean).join(' ')} ==`);
    for (const e of list(p.epics)) {
      out.push(`EPIC · ${e.name}: ${epicBar(e)} ${epicCount(e)}`);
    }
    if (p.also) out.push(`➕ Also: ${plain(p.also)}`);
    const ready = list(p.ready);
    out.push('', '✅ Ready to test');
    if (!ready.length) out.push('Nothing ready to test');
    for (const item of ready) {
      out.push(`- ${plain(item.what)}: ${plain(readyHow(item).text)}`);
    }
    const waiting = list(p.waiting);
    out.push('', '🙋 Waiting on you');
    if (!waiting.length) out.push('Nothing waiting on you');
    for (const w of waiting) {
      out.push(
        w.setup
          ? `- 🔧 Setup step: ${plain(w.setup)}`
          : `- ${plain(w.decision)} | My pick: ${plain(w.pick)} | Blocks: ${plain(w.blocks)}`,
      );
    }
    const busy = list(p.inProgress);
    out.push(
      '',
      `🟡 In progress: ${busy.length ? busy.map(plain).join(' · ') : 'nothing'}`,
    );
  }
  const ideas = list(report.ideas);
  if (ideas.length) {
    out.push(
      '',
      '💡 New ideas to place (nothing starts until you rank them)',
      ...ideas.map((i) => `- ${plain(idea(i))}`),
    );
  }
  out.push('', '🟩 done · 🟨 in progress · ⬜ queued · ➕ outside the epics');
  const todo = todoLink(report, config);
  if (todo) out.push(`📋 ${todo.label}: ${todo.url}`);
  return out.join('\n');
}

export async function sendReport(
  { subject, report },
  { env = process.env, fetchFn = fetch } = {},
) {
  const config = loadConfig(env);
  const res = await fetchFn('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: config.EMAIL_FROM,
      to: config.REPORT_EMAIL_TO,
      subject: subject || subjectFor(report),
      text: renderText(report, config),
      html: renderHtml(report, config),
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  return res.json();
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({
    options: { subject: { type: 'string' }, data: { type: 'string' } },
  });
  if (!values.data) {
    console.error(
      'usage: send-report.mjs --data <report.json> [--subject <s>]',
    );
    process.exit(2);
  }
  try {
    const report = JSON.parse(readFileSync(values.data, 'utf8'));
    const { id } = await sendReport({ subject: values.subject, report });
    console.log(`sent ${id}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
