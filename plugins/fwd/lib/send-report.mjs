#!/usr/bin/env node
// Email a run report through Resend, so a long run ends with a message in the user's inbox rather
// than a transcript they must come back to read. The orchestrator calls it as the last step of a
// run, and again when a run blocks on a decision only the user can make.
//
//   node send-report.mjs --subject "<subject>" --body-file <report.md>
//
// Config is read from the environment, then from `report-email.json` in the plugin data folder:
// RESEND_API_KEY, EMAIL_FROM, REPORT_EMAIL_TO. Nothing is stored in the repository.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { isMain } from './is-main.mjs';
import { pluginDataDir } from './plugin-data.mjs';

const KEYS = ['RESEND_API_KEY', 'EMAIL_FROM', 'REPORT_EMAIL_TO'];

export function loadConfig(env = process.env) {
  let file = {};
  try {
    file = JSON.parse(
      readFileSync(join(pluginDataDir(env), 'report-email.json'), 'utf8'),
    );
  } catch {
    // no file: the environment alone must carry the config
  }
  const config = Object.fromEntries(KEYS.map((k) => [k, env[k] || file[k]]));
  const missing = KEYS.filter((k) => !config[k]);
  if (missing.length) throw new Error(`missing config: ${missing.join(', ')}`);
  return config;
}

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const inline = (s) =>
  escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');

const cells = (line) =>
  line
    .replace(/^\s*\||\|\s*$/g, '')
    .split('|')
    .map((c) => c.trim());

// The subset of markdown the run reports use: headings, bullets, numbered lists, tables, links,
// bold and code. Anything else passes through as an escaped paragraph.
export function markdownToHtml(md) {
  const out = [];
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = line.match(/^(#{1,3})\s+(.*)/);
    if (heading) {
      out.push(
        `<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`,
      );
    } else if (
      /^\s*\|/.test(line) &&
      /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')
    ) {
      const rows = [
        `<tr>${cells(line)
          .map((c) => `<th>${inline(c)}</th>`)
          .join('')}</tr>`,
      ];
      for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]); i++) {
        rows.push(
          `<tr>${cells(lines[i])
            .map((c) => `<td>${inline(c)}</td>`)
            .join('')}</tr>`,
        );
      }
      i--;
      out.push(`<table>${rows.join('')}</table>`);
    } else if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const tag = /^\s*\d/.test(line) ? 'ol' : 'ul';
      const items = [];
      for (; i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i]); i++) {
        items.push(
          `<li>${inline(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''))}</li>`,
        );
      }
      i--;
      out.push(`<${tag}>${items.join('')}</${tag}>`);
    } else if (line.trim()) {
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  return `<div style="font-family:-apple-system,system-ui,sans-serif;max-width:640px;line-height:1.45">${out.join('\n')}</div>`;
}

export async function sendReport(
  { subject, body },
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
      subject,
      text: body,
      html: markdownToHtml(body),
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  return res.json();
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({
    options: { subject: { type: 'string' }, 'body-file': { type: 'string' } },
  });
  if (!values.subject || !values['body-file']) {
    console.error(
      'usage: send-report.mjs --subject <subject> --body-file <file>',
    );
    process.exit(2);
  }
  try {
    const { id } = await sendReport({
      subject: values.subject,
      body: readFileSync(values['body-file'], 'utf8'),
    });
    console.log(`sent ${id}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
