// The route inventory: one JSON file per feature, read by the contact sheet (every row at every
// width) and by check-shared (every row's `view` against the `shares` block). The schema is in the
// feature-acceptance skill; this module is its one validator, so both tools refuse the same
// malformed file the same way.
//
// Everything here is pure, so the rules that decide whether a run can quietly pass are pinned by
// tests rather than trusted: an unknown verb, an empty `widths`, a row with no steps and a local
// base URL are all errors before a browser starts.

/**
 * The verbs a step may carry, in the order they run within one step. A verb that must run in
 * another order goes in its own step. Anything else is a typo, and a typo'd verb is a step that
 * silently does nothing while its cell counts as reached, so it fails validation.
 */
export const VERBS = [
  'goto', // project-relative path, `${VAR}` expanded from the environment
  'store', // { key: value } written to localStorage
  'click', // selector, scoped to the page
  'clickRole', // ARIA role, with `name` (a regex, `${VAR}` escaped) scoped to the page
  'fill', // selector, with `text` (`${VAR}` expanded)
  'wait', // selector, scoped to the page, waited for visible
  'waitDialog', // a dialog's accessible name; not page-scoped (dialogs portal to <body>)
  'hover', // selector, scoped to the page
  'back', // true: browser back
  'offline', // true or false: the browser's offline switch
  'pressKey', // a key name, e.g. "Escape"
  'settle', // milliseconds; a delay, not a readiness check
  'scrollTo', // selector, scrolled to the viewport centre
  'scroll', // a pixel offset, or "bottom"
];
const ARGS = { clickRole: ['name'], fill: ['text'] };
const ROW_KEYS = [
  'id',
  'label',
  'view',
  'binding',
  'widths',
  'fullPage',
  'steps',
];
const TOP_KEYS = [
  'feature',
  'note',
  'out',
  'signedOut',
  'fullPage',
  'widths',
  'cookies',
  'shares',
  'rows',
];

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Widths are `{ label, width, height, touch? }`, labels unique. Returns error strings. */
export function widthErrors(widths, where) {
  if (!Array.isArray(widths) || widths.length === 0)
    return [`${where}: widths must be a non-empty array`];
  const errors = [];
  const seen = new Set();
  for (const w of widths) {
    if (
      !isObject(w) ||
      typeof w.label !== 'string' ||
      !/^[a-z0-9-]+$/.test(w.label) ||
      !Number.isInteger(w.width) ||
      !Number.isInteger(w.height)
    )
      errors.push(
        `${where}: each width is { "label": "phone", "width": 390, "height": 844 } (label lowercase)`,
      );
    else if (seen.has(w.label)) errors.push(`${where}: width ${w.label} twice`);
    seen.add(w?.label);
  }
  return errors;
}

/**
 * Every reason this inventory cannot be run or checked, as messages naming the row. Empty means
 * valid. `widthLabels` are the labels the run will use (config or the inventory's own).
 */
export function inventoryErrors(inventory, widthLabels) {
  if (!isObject(inventory)) return ['the inventory is not a JSON object'];
  const errors = [];
  for (const key of Object.keys(inventory))
    if (!TOP_KEYS.includes(key)) errors.push(`unknown top-level key "${key}"`);
  if (typeof inventory.feature !== 'string' || !inventory.feature)
    errors.push('"feature" names the feature (the sheet title)');
  if (inventory.widths !== undefined)
    errors.push(...widthErrors(inventory.widths, 'inventory'));
  const rows = inventory.rows;
  // No rows would photograph nothing and exit 0: the quiet pass this artifact exists to prevent.
  if (!Array.isArray(rows) || rows.length === 0)
    return [...errors, '"rows" must be a non-empty array'];

  const ids = new Set();
  rows.forEach((row, i) => {
    const at = `row ${row?.id ?? i}`;
    if (!isObject(row)) return errors.push(`row ${i} is not an object`);
    for (const key of Object.keys(row))
      if (!ROW_KEYS.includes(key)) errors.push(`${at}: unknown key "${key}"`);
    // The id names the screenshot file, so it is a safe file name and unique.
    if (typeof row.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(row.id))
      errors.push(`${at}: "id" is lowercase letters, digits and dashes`);
    else if (ids.has(row.id)) errors.push(`${at}: id used twice`);
    ids.add(row.id);
    if (typeof row.label !== 'string' || !row.label)
      errors.push(`${at}: "label" says what the cell shows`);
    if (row.widths !== undefined) {
      const ok =
        Array.isArray(row.widths) &&
        row.widths.length > 0 &&
        row.widths.every((w) => widthLabels.includes(w));
      if (!ok)
        errors.push(
          `${at}: "widths" must be a non-empty subset of ${widthLabels.join(', ')}`,
        );
    }
    if (!Array.isArray(row.steps) || row.steps.length === 0)
      errors.push(`${at}: "steps" must be a non-empty array`);
    else
      row.steps.forEach((step, j) =>
        errors.push(...stepErrors(step, `${at} step ${j}`)),
      );
  });
  const cookies = inventory.cookies;
  if (
    cookies !== undefined &&
    !(
      Array.isArray(cookies) &&
      cookies.every(
        (c) => typeof c?.name === 'string' && typeof c?.value === 'string',
      )
    )
  )
    errors.push('"cookies" is [{ "name": "theme", "value": "${THEME}" }]');
  errors.push(...sharesErrors(inventory));
  return errors;
}

function stepErrors(step, at) {
  if (!isObject(step)) return [`${at}: not an object`];
  const errors = [];
  const keys = Object.keys(step);
  const verbs = keys.filter((k) => VERBS.includes(k));
  if (verbs.length === 0)
    errors.push(`${at}: no verb (one of ${VERBS.join(', ')})`);
  for (const key of keys) {
    const owner = Object.entries(ARGS).find(([, args]) =>
      args.includes(key),
    )?.[0];
    if (owner && !keys.includes(owner))
      errors.push(`${at}: "${key}" belongs with "${owner}"`);
    else if (!owner && !VERBS.includes(key))
      errors.push(`${at}: unknown verb "${key}"`);
  }
  for (const [verb, args] of Object.entries(ARGS))
    for (const arg of args)
      if (keys.includes(verb) && typeof step[arg] !== 'string')
        errors.push(`${at}: "${verb}" needs "${arg}"`);
  // An empty selector is a step that would silently not happen.
  for (const verb of [
    'goto',
    'click',
    'clickRole',
    'fill',
    'wait',
    'waitDialog',
    'hover',
    'scrollTo',
    'pressKey',
  ])
    if (keys.includes(verb) && (typeof step[verb] !== 'string' || !step[verb]))
      errors.push(`${at}: "${verb}" takes a non-empty string`);
  if (
    keys.includes('goto') &&
    typeof step.goto === 'string' &&
    !step.goto.startsWith('/')
  )
    errors.push(
      `${at}: "goto" is a path starting with /, joined to the base URL`,
    );
  if (
    keys.includes('settle') &&
    !(Number.isInteger(step.settle) && step.settle >= 0)
  )
    errors.push(`${at}: "settle" is whole milliseconds`);
  if (
    keys.includes('scroll') &&
    !(Number.isInteger(step.scroll) || step.scroll === 'bottom')
  )
    errors.push(`${at}: "scroll" is a pixel offset or "bottom"`);
  if (keys.includes('store') && !isObject(step.store))
    errors.push(`${at}: "store" is { key: value }`);
  for (const verb of ['back', 'offline'])
    if (keys.includes(verb) && typeof step[verb] !== 'boolean')
      errors.push(`${at}: "${verb}" is true or false`);
  return errors;
}

/** The `shares` block: `{ binding, module }` or an array of them, each row then naming its binding. */
export function sharesErrors(inventory) {
  const { shares, rows } = inventory;
  if (shares === undefined) return [];
  const entries = Array.isArray(shares) ? shares : [shares];
  if (entries.length === 0)
    return ['"shares" is an empty array, so it would check nothing'];
  const errors = [];
  const bindings = new Set();
  for (const e of entries) {
    if (
      !isObject(e) ||
      typeof e.binding !== 'string' ||
      typeof e.module !== 'string'
    )
      errors.push(
        'each "shares" entry is { "binding": "Name", "module": "src/path/file" }',
      );
    else if (bindings.has(e.binding))
      errors.push(`"shares" names ${e.binding} twice`);
    bindings.add(e?.binding);
  }
  for (const row of Array.isArray(rows) ? rows : []) {
    // Views come off the rows, so a row cannot be added without one and sit outside the check.
    if (typeof row?.view !== 'string' || !row.view)
      errors.push(
        `row ${row?.id}: "shares" is declared, so every row names its "view"`,
      );
    if (Array.isArray(shares) && !bindings.has(row?.binding))
      errors.push(
        `row ${row?.id}: "shares" lists several controls, so the row names one in "binding"`,
      );
  }
  return errors;
}

/**
 * `${VAR}` from the environment, so no inventory commits one account's ids. A missing variable
 * throws: typing a literal `${ID}` into a search box photographs an empty list as a reached cell.
 * With `forRegex`, the value is escaped, since `clickRole.name` is a pattern.
 */
export function expand(
  value,
  where,
  env = process.env,
  { forRegex = false } = {},
) {
  return String(value ?? '').replace(/\$\{(\w+)\}/g, (_, name) => {
    const found = env[name];
    if (!found) throw new Error(`${where} needs ${name} in the environment`);
    return forRegex ? found.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : found;
  });
}

/**
 * Why this base URL is refused, or null. The contact sheet photographs a deployed build (staging,
 * a preview): a local build is not what users get, and a local server's data is fixtures.
 */
export function baseUrlError(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return `not a URL: ${raw}`;
  }
  if (url.protocol !== 'https:')
    return `${raw} is not https: point the sheet at a deployed URL such as staging`;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const local =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host === '::1' ||
    host === '0.0.0.0' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (local)
    return `${raw} is a local address: the sheet photographs a deployed build, never a local one`;
  if (url.pathname !== '/' || url.search || url.hash)
    return `${raw}: the base URL is an origin only; paths go in each row's goto`;
  return null;
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The sheet page: every shot as a captioned figure, inlined as data URIs (the sheet is built on
 * about:blank, a different origin from any file:// path). `shots` are `{ label, size, note, data }`.
 */
export function sheetHtml(feature, shots) {
  const cards = shots
    .map((s) => {
      const img = s.data
        ? `<img src="data:image/png;base64,${s.data}" />`
        : '<div class="missing">no screenshot</div>';
      const note = s.note ? ` <b>— ${escapeHtml(s.note)}</b>` : '';
      return `<figure>${img}<figcaption>${escapeHtml(s.label)} · ${escapeHtml(s.size)}${note}</figcaption></figure>`;
    })
    .join('');
  return `<style>
  body { background: #14110e; color: #ede6d8; font: 13px/1.4 system-ui, sans-serif; margin: 0; padding: 20px; }
  h1 { font-size: 16px; margin: 0 0 14px; }
  .grid { display: flex; flex-wrap: wrap; gap: 14px; align-items: flex-start; }
  figure { margin: 0; width: 420px; }
  img { width: 100%; border: 1px solid #3a3229; display: block; }
  figcaption { padding-top: 6px; color: #a89b84; }
  .missing { height: 200px; display: grid; place-items: center; border: 1px dashed #6e6654; }
  b { color: #e8927c; }
</style>
<h1>${escapeHtml(feature)}: every route, every width</h1>
<div class="grid">${cards}</div>`;
}
