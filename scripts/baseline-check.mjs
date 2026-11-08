// Compares a project against baseline.json. .github/workflows/baseline.yml runs it from the
// caller's checkout as `node .fwd-kit/scripts/baseline-check.mjs .fwd-kit/baseline.json`, with
// MODE=warn (default) or fail.
// `check` is pure so tests/baseline.test.mjs can feed it sample package.json files.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'];

// The leading version numbers of a spec ("^16.4.5" -> [16, 4, 5]), or null for one that names no
// version (workspace:*, catalog:, a git URL, latest).
const numbers = (spec) => {
  const match = /^[\s^~>=v]*(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(spec);
  return match
    ? match
        .slice(1)
        .filter((n) => n !== undefined)
        .map(Number)
    : null;
};

// A package.json's fwdBaseline.ignore. Anything but an array of strings is an error, not a
// silently empty list.
const ignoreList = ({ path, json }) => {
  const list = json.fwdBaseline?.ignore ?? [];
  if (!Array.isArray(list) || list.some((name) => typeof name !== 'string'))
    throw new Error(
      `${path}: fwdBaseline.ignore must be an array of package names`,
    );
  return list;
};

// Whether a declared spec allows the baseline version. Each `||` branch is read on its own, so
// `^15.0.0 || ^16.0.0` allows 16. Null when no branch names a version (workspace:*, catalog:).
const allows = (spec, want) => {
  const parts = want.split('.').length;
  const branches = spec.split('||').map(numbers).filter(Boolean);
  if (!branches.length) return null;
  return branches.some((got) => got.slice(0, parts).join('.') === want);
};

// Whether a pin is older than the minimum. A pin that omits its minor or patch ("24") resolves to
// the newest one, so only the parts the pin states are compared.
const below = (pin, min) => {
  for (const [i, n] of pin.entries()) if (n !== min[i]) return n < min[i];
  return false;
};

/**
 * @param {{ baseline: any, packages: { path: string, json: any }[], nodePin: { path: string, text: string } | null }} input
 * @returns {{ file: string, message: string }[]}
 */
export function check({ baseline, packages, nodePin }) {
  const root = packages.find((p) => p.path === 'package.json');
  const rootIgnore = root ? ignoreList(root) : [];
  const findings = [];
  for (const { path, json } of packages) {
    const ignore = new Set([...rootIgnore, ...ignoreList({ path, json })]);
    for (const [name, want] of Object.entries(baseline.packages)) {
      if (ignore.has(name)) continue;
      for (const field of DEP_FIELDS) {
        const spec = json[field]?.[name];
        // A 0.x pin ("0.45") compares major.minor; anything else compares the major.
        if (typeof spec === 'string' && allows(spec, want) === false)
          findings.push({
            file: path,
            message: `${name} ${spec} in ${field}; the baseline is ${want}`,
          });
      }
    }
  }
  if (!rootIgnore.includes('node')) {
    const pin = nodePin && numbers(nodePin.text.trim());
    if (!nodePin)
      findings.push({
        file: 'package.json',
        message: `no Node version pin (.nvmrc or .node-version) to check against ${baseline.nodeMinimum}`,
      });
    else if (!pin)
      findings.push({
        file: nodePin.path,
        message: `Node pin ${nodePin.text.trim()} is not a version number; the baseline is at least ${baseline.nodeMinimum}`,
      });
    else if (
      pin[0] !== Number(baseline.node) ||
      below(pin, numbers(baseline.nodeMinimum))
    )
      findings.push({
        file: nodePin.path,
        message: `Node ${nodePin.text.trim()}; the baseline is Node ${baseline.node}, at least ${baseline.nodeMinimum}`,
      });
  }
  if (!root)
    findings.push({
      file: 'package.json',
      message:
        'no tracked root package.json, so packageManager cannot be checked',
    });
  else if (!rootIgnore.includes('pnpm')) {
    const [manager, version = ''] = (root.json.packageManager ?? '').split('@');
    if (
      manager !== 'pnpm' ||
      numbers(version)?.[0] !== numbers(baseline.pnpm)[0]
    )
      findings.push({
        file: 'package.json',
        message: `packageManager ${root.json.packageManager ?? '(unset)'}; the baseline is pnpm ${baseline.pnpm}`,
      });
  }
  return findings;
}

// Annotation text: GitHub reads %, CR and LF as escapes, and , and : end a property.
const annotation = (text, property = false) => {
  const out = text
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
  return property ? out.replace(/,/g, '%2C').replace(/:/g, '%3A') : out;
};

// realpath on both sides, so a symlinked path to the script still runs it rather than passing silently.
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const mode = process.env.MODE || 'warn';
  if (mode !== 'warn' && mode !== 'fail')
    throw new Error(`mode must be warn or fail, not ${mode}`);
  const baseline = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const tracked = execFileSync('git', ['ls-files', '*package.json'], {
    encoding: 'utf8',
  }).split('\n');
  const packages = tracked
    .filter(
      (path) =>
        /(^|\/)package\.json$/.test(path) && !/(^|\/)fixtures\//.test(path),
    )
    .map((path) => ({ path, json: JSON.parse(readFileSync(path, 'utf8')) }));
  const pinPath = ['.nvmrc', '.node-version'].find((path) => existsSync(path));
  const nodePin = pinPath
    ? { path: pinPath, text: readFileSync(pinPath, 'utf8') }
    : null;
  const findings = check({ baseline, packages, nodePin });
  const level = mode === 'fail' ? 'error' : 'warning';
  for (const { file, message } of findings)
    process.stdout.write(
      `::${level} file=${annotation(file, true)},title=fwd baseline::${annotation(message)}\n`,
    );
  process.stdout.write(
    `fwd baseline: ${findings.length} mismatch(es), mode ${mode}\n`,
  );
  if (mode === 'fail' && findings.length) process.exitCode = 1;
}
