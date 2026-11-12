// The route inventory: one JSON file per feature, read by the contact sheet (every row at every
// width) and by check-shared (every row's `view` against the `shares` block). The schema is in the
// feature-acceptance skill; this module is its one validator, so both tools refuse the same
// malformed file the same way.
//
// Everything here is pure, so the rules that decide whether a run can quietly pass are pinned by
// tests rather than trusted: an unknown verb, an empty `widths`, a row with no steps and a
// production or plaintext-remote base URL are all errors before a browser starts.

/**
 * The verbs a step may carry, in the order they run within one step. A verb that must run in
 * another order goes in its own step. Anything else is a typo, and a typo'd verb is a step that
 * silently does nothing while its cell counts as reached, so it fails validation.
 */
export const VERBS = [
  'route', // a URL glob this row's requests to are answered with `status` and `body`
  'goto', // project-relative path, `${VAR}` expanded; `expectStatus`, `expectRedirect` optional
  'store', // { key: value } written to localStorage
  'click', // selector, scoped to the page
  'clickRole', // ARIA role, with `name` (a regex, `${VAR}` escaped) scoped to the page
  'fill', // selector, with `text` (`${VAR}` expanded)
  'wait', // selector, scoped to the page, waited for visible
  'waitDialog', // a dialog's accessible name, a regex like clickRole's; not page-scoped
  'hover', // selector, scoped to the page
  'back', // true: browser back
  'offline', // true or false: the browser's offline switch
  'pressKey', // a key name, e.g. "Escape"
  'settle', // milliseconds; a delay, not a readiness check
  'scrollTo', // selector, scrolled to the viewport centre
  'scroll', // a pixel offset, or "bottom"
];
/** Arguments that ride with a verb. REQUIRED ones must be present; the rest are optional. */
const ARGS = {
  route: ['status', 'body'],
  goto: ['expectStatus', 'expectRedirect'],
  clickRole: ['name'],
  fill: ['text'],
};
const REQUIRED = { clickRole: 'name', fill: 'text' };
const ROUTE_ONLY = ['route', ...ARGS.route];
const THEME_KEYS = ['label', 'cookies', 'storage', 'colorScheme', 'dataTheme'];
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
  'themes',
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

const cookieListOk = (cookies) =>
  Array.isArray(cookies) &&
  cookies.every(
    (c) => typeof c?.name === 'string' && typeof c?.value === 'string',
  );

/**
 * Themes are `{ label, dataTheme, cookies?, storage?, colorScheme? }`, labels unique: each one is
 * a fresh browser context the whole sheet is photographed in. `cookies` and `storage` (localStorage,
 * written before the page's own scripts run) select the theme the way the app reads it;
 * `colorScheme` is the emulated `prefers-color-scheme`; `dataTheme` is read back from
 * `<html data-theme>` after every row, so a theme the app ignored fails rather than photographing
 * the default under the asked-for name. Returns error strings.
 */
export function themeErrors(themes, where) {
  if (!Array.isArray(themes) || themes.length === 0)
    return [`${where}: themes must be a non-empty array`];
  const errors = [];
  const seen = new Set();
  for (const t of themes) {
    if (
      !isObject(t) ||
      typeof t.label !== 'string' ||
      !/^[a-z0-9-]+$/.test(t.label)
    ) {
      errors.push(
        `${where}: each theme is { "label": "electric", ... } (label lowercase letters, digits, dashes)`,
      );
      continue;
    }
    const at = `${where}: theme ${t.label}`;
    if (seen.has(t.label)) errors.push(`${at} twice`);
    seen.add(t.label);
    for (const key of Object.keys(t))
      if (!THEME_KEYS.includes(key)) errors.push(`${at}: unknown key "${key}"`);
    if (t.cookies !== undefined && !cookieListOk(t.cookies))
      errors.push(`${at}: "cookies" is [{ "name": "theme", "value": "dark" }]`);
    if (
      t.storage !== undefined &&
      !(
        isObject(t.storage) &&
        Object.values(t.storage).every((v) => typeof v === 'string')
      )
    )
      errors.push(`${at}: "storage" is { "key": "value" }, values strings`);
    if (
      t.colorScheme !== undefined &&
      !['light', 'dark', 'no-preference'].includes(t.colorScheme)
    )
      errors.push(`${at}: "colorScheme" is "light", "dark" or "no-preference"`);
    // Required: the read-back is what stops a typo'd cookie or key photographing the default.
    if (typeof t.dataTheme !== 'string' || !t.dataTheme)
      errors.push(
        `${at}: "dataTheme" is the <html data-theme> value the theme draws`,
      );
    // Theme values are literal: a theme is not an account, so nothing in it comes from the env.
    if (JSON.stringify([t.cookies, t.storage]).includes('${'))
      errors.push(
        `${at}: theme values are literal; \${VAR} is not expanded here`,
      );
    // A theme that sets nothing photographs the default theme under another name.
    if (
      t.cookies === undefined &&
      t.storage === undefined &&
      t.colorScheme === undefined
    )
      errors.push(
        `${at}: set "cookies", "storage" or "colorScheme", or it draws the default`,
      );
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
  if (inventory.themes !== undefined)
    errors.push(...themeErrors(inventory.themes, 'inventory'));
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
    else {
      row.steps.forEach((step, j) =>
        errors.push(...stepErrors(step, `${at} step ${j}`)),
      );
      // Rows share one page per width, so a row that does not load its own route photographs
      // whatever the previous row (or a failed one) left behind. Only `route` may come first, since
      // a mock has to be in place before the load it answers.
      const first = row.steps.find(
        (s) =>
          !isObject(s) || Object.keys(s).some((k) => !ROUTE_ONLY.includes(k)),
      );
      if (first?.goto === undefined)
        errors.push(`${at}: the first step loads the row's route with "goto"`);
    }
  });
  const cookies = inventory.cookies;
  if (cookies !== undefined && !cookieListOk(cookies))
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
  for (const [verb, arg] of Object.entries(REQUIRED))
    if (keys.includes(verb) && typeof step[arg] !== 'string')
      errors.push(`${at}: "${verb}" needs "${arg}"`);
  // An empty pattern matches every element of the role: the first one is clicked, silently.
  if (keys.includes('clickRole') && step.name === '')
    errors.push(`${at}: "name" takes a non-empty pattern`);
  // A pattern that does not compile fails at the step, mid-run; say so before a browser starts.
  for (const [key, value] of [
    ['name', step.name],
    ['waitDialog', step.waitDialog],
  ])
    if (typeof value === 'string')
      try {
        new RegExp(value.replace(/\$\{\w+\}/g, 'x'));
      } catch {
        errors.push(`${at}: "${key}" is not a valid regex`);
      }
  // A browser follows redirects, so a goto never ends on a 3xx: that is `expectRedirect`.
  if (
    keys.includes('expectStatus') &&
    !(
      Number.isInteger(step.expectStatus) &&
      ((step.expectStatus >= 200 && step.expectStatus < 300) ||
        (step.expectStatus >= 400 && step.expectStatus <= 599))
    )
  )
    errors.push(
      `${at}: "expectStatus" is the HTTP status the page answers, e.g. 404`,
    );
  if (
    keys.includes('expectRedirect') &&
    !(
      typeof step.expectRedirect === 'string' &&
      step.expectRedirect.startsWith('/')
    )
  )
    errors.push(
      `${at}: "expectRedirect" is the path the goto lands on, e.g. "/sign-in"`,
    );
  if (keys.includes('route')) {
    if (
      keys.includes('status') &&
      !(
        Number.isInteger(step.status) &&
        step.status >= 100 &&
        step.status <= 599
      )
    )
      errors.push(`${at}: "status" is an HTTP status`);
    if (!keys.includes('status') && !keys.includes('body'))
      errors.push(`${at}: "route" answers with "status", "body" or both`);
  }
  // An empty selector is a step that would silently not happen.
  for (const verb of [
    'route',
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
  // A bare element name ("h1", "main", "table") is drawn by the loading skeleton and the signed-out
  // shell too, so the wait passes before the content arrives and the cell photographs nothing real.
  if (
    keys.includes('wait') &&
    typeof step.wait === 'string' &&
    /^[a-z][a-z0-9-]*$/i.test(step.wait.trim())
  )
    errors.push(
      `${at}: "wait" on a bare "${step.wait.trim()}" passes on a loading skeleton; wait for the content itself (a data-testid, a role and name, or its text)`,
    );
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
 * Every value `${VAR}` has expanded to, by variable name. An inventory's variables are account ids
 * and invite tokens, so each value is scrubbed from everything the tools print or write: a
 * Playwright error quotes the URL it navigated to, a redirect names the path it landed on, and a
 * sign-in module's error may quote anything.
 */
const secrets = new Map();

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Records `value` as a secret named `name`; empty values are not secrets. */
export function addSecret(name, value) {
  if (typeof value === 'string' && value) secrets.set(value, name);
}

/**
 * Records the environment value of every `${VAR}` anywhere in `value` (an inventory, walked whole),
 * before any of it runs, so output is scrubbed even of a value no step has expanded yet.
 */
export function registerSecrets(value, env = process.env) {
  if (typeof value === 'string')
    for (const [, name] of value.matchAll(/\$\{(\w+)\}/g))
      addSecret(name, env[name]);
  else if (Array.isArray(value)) for (const v of value) registerSecrets(v, env);
  else if (isObject(value))
    for (const v of Object.values(value)) registerSecrets(v, env);
}

/** Environment names that hold credentials by convention: a sign-in module's own secrets. */
const SECRET_NAME =
  /TOKEN|SECRET|PASSWORD|PASSWD|INVITE|COOKIE|CREDENTIAL|API_?KEY|PRIVATE/i;

/**
 * Records every environment value whose NAME says it is a credential (and is at least 6 characters,
 * so a flag like `1` is not scrubbed from every line), so a sign-in module that quotes its own
 * password or token in an error is redacted too, though no inventory names it.
 */
export function registerSecretEnv(env = process.env) {
  for (const [name, value] of Object.entries(env))
    if (
      SECRET_NAME.test(name) &&
      typeof value === 'string' &&
      value.length >= 6
    )
      addSecret(name, value);
}

/**
 * `text` with every recorded secret replaced by `[redacted NAME]`, in each form output can carry
 * it: as typed, URL-encoded (a page URL), regex-escaped (a clickRole pattern) and JSON-escaped.
 * Longest first, so a secret that contains another is replaced whole.
 */
export function redact(text) {
  let out = String(text);
  const forms = [];
  for (const [value, name] of secrets)
    for (const form of new Set([
      value,
      encodeURIComponent(value),
      encodeURI(value),
      escapeRegex(value),
      // A RegExp prints its source with `/` escaped: Playwright's call log of a role name.
      escapeRegex(value).replaceAll('/', '\\/'),
      JSON.stringify(value).slice(1, -1),
    ]))
      forms.push([form, name]);
  forms.sort((a, b) => b[0].length - a[0].length);
  for (const [form, name] of forms)
    out = out.split(form).join(`[redacted ${name}]`);
  return out;
}

/**
 * `${VAR}` from the environment, so no inventory commits one account's ids. A missing variable
 * throws: typing a literal `${ID}` into a search box photographs an empty list as a reached cell.
 * With `forRegex`, the value is escaped, since `clickRole.name` and `waitDialog` are patterns. With
 * `forPath`, a value that would change the URL's query or fragment throws: the cell would load
 * another page, and the redirect check compares paths only.
 * Every value expanded is recorded for `redact`.
 */
export function expand(
  value,
  where,
  env = process.env,
  { forRegex = false, forPath = false } = {},
) {
  return String(value ?? '').replace(/\$\{(\w+)\}/g, (_, name) => {
    const found = env[name];
    if (!found) throw new Error(`${where} needs ${name} in the environment`);
    addSecret(name, found);
    if (forPath && /[?#\\\s]/.test(found))
      throw new Error(
        `${where}: ${name} holds a ?, #, \\ or space, which would change the URL rather than fill a path`,
      );
    return forRegex ? escapeRegex(found) : found;
  });
}

/** Hostname without brackets or trailing dots, lowercased: `localhost.` is localhost. */
const hostOf = (url) =>
  url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '')
    .toLowerCase();

/**
 * This machine: the lane's own dev server. Addresses only: `127.example.com` is a name, not
 * loopback, and plaintext to it would send the sign-in in the clear.
 */
const isLoopback = (host) =>
  host === 'localhost' ||
  host === '::1' ||
  /^127(\.\d{1,3}){3}$/.test(host) ||
  /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(host);

/**
 * Why this base URL is refused, or null.
 *
 * Before a PR opens, the change exists only on the lane's machine, so the sheet's pre-PR target is
 * the local DEV server (`pnpm dev` at http://localhost:<port>; a dev server is not a build or a test
 * run). After merge, staging or a preview is the target for audits. Any other origin must be https.
 * The project's production origins (`productionUrl`, one or a list of every alias) are refused
 * when set: a signed-in walk there runs against real users' data.
 */
export function baseUrlError(raw, { productionUrl } = {}) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return `not a URL: ${raw}`;
  }
  if (url.pathname !== '/' || url.search || url.hash)
    return `${raw}: the base URL is an origin only; paths go in each row's goto`;
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return `${raw}: the base URL is http or https`;
  const host = hostOf(url);
  if (!isLoopback(host) && url.protocol !== 'https:')
    return `${raw} is not https: use the local dev server (http://localhost:<port>) or an https staging or preview origin`;
  if (productionUrl === undefined) return null;
  const prods = [productionUrl].flat();
  if (prods.length === 0 || prods.some((p) => typeof p !== 'string' || !p))
    return 'featureAcceptance.productionUrl is an origin, or a list of every production origin; omit it rather than leave it empty';
  for (const p of prods) {
    let prod;
    try {
      prod = new URL(p);
    } catch {
      return `featureAcceptance.productionUrl is not a URL: ${p}`;
    }
    if (hostOf(prod) === host && prod.port === url.port)
      return `${raw} is production (featureAcceptance.productionUrl): sheet the local dev server before the PR, staging after merge`;
  }
  return null;
}

const escapeHtml = (s) =>
  redact(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The sheet page: every shot as a captioned figure, inlined as data URIs (the sheet is built on
 * about:blank, a different origin from any file:// path). `shots` are `{ label, size, note, data }`.
 * Every text on it is redacted as well as escaped.
 */
export function sheetHtml(feature, shots, origin = '') {
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
<h1>${escapeHtml(feature)}: every route, every width${origin ? ` · ${escapeHtml(origin)}` : ''}</h1>
<div class="grid">${cards}</div>`;
}
