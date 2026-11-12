import fs from 'node:fs';
import path from 'node:path';

/** Defaults — every field can be overridden in i18n-guard.config.json */
export const DEFAULTS = {
  sourceDirs: ['src'],
  extensions: ['.ts', '.tsx', '.js', '.jsx'],
  locales: {},
  baseLocale: 'en',
  requireDot: true,
  callNames: ['t'],
  dotTrSuffix: false,
  ignoreKeys: [],
  ignorePrefixes: [],
  ignoreDirs: ['node_modules', 'dist', 'build', '.git', 'coverage'],
};

const LANG = /^[a-z]{2,3}([-_][A-Za-z]{2,4})?$/;

export const flatten = (obj, prefix = '', out = {}) => {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
};
const getPath = (obj, key) => key.split('.').reduce((n, k) => (n && typeof n === 'object' ? n[k] : undefined), obj);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;

export function walk(dir, { exts, ignoreDirs }, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignoreDirs.includes(e.name) || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, { exts, ignoreDirs }, out);
    else if (!exts || exts.includes(path.extname(e.name))) out.push(p);
  }
  return out;
}

export function loadConfig(root, explicitPath) {
  const candidates = explicitPath
    ? [path.resolve(root, explicitPath)]
    : ['i18n-guard.config.json', 'i18n-check.config.json', 'scripts/i18n-guard.config.json'].map((p) => path.join(root, p));
  const file = candidates.find((p) => fs.existsSync(p));
  if (!file) return null;
  return { file, cfg: { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) } };
}

/** Guess a config for the project in `root` (used by `i18n-guard init`). */
export function detectConfig(root) {
  const isFlutter = fs.existsSync(path.join(root, 'pubspec.yaml'));
  const cfg = { ...DEFAULTS, locales: {} };
  if (isFlutter) {
    Object.assign(cfg, { sourceDirs: ['lib'], extensions: ['.dart'], callNames: ['tr'], dotTrSuffix: true, requireDot: false });
  } else {
    const dirs = ['src', 'app', 'pages', 'components', 'lib'].filter((d) => fs.existsSync(path.join(root, d)));
    cfg.sourceDirs = dirs.length ? dirs : ['.'];
    cfg.extensions = ['.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte'];
    cfg.callNames = ['t', '$t'];
  }
  // find locale json files: group by the path pattern with the language segment replaced
  const jsons = walk(root, { exts: ['.json'], ignoreDirs: cfg.ignoreDirs.concat(['android', 'ios', 'windows', 'linux', 'macos', 'web', 'build']) });
  const patterns = new Map();
  for (const f of jsons) {
    const rel = path.relative(root, f).replace(/\\/g, '/');
    const parts = rel.split('/');
    const base = parts[parts.length - 1].replace(/\.json$/, '');
    let idx = -1;
    if (LANG.test(base)) idx = parts.length - 1;
    else if (parts.length > 1 && LANG.test(parts[parts.length - 2])) idx = parts.length - 2;
    if (idx < 0) continue;
    const lang = idx === parts.length - 1 ? base : parts[idx];
    const pat = parts.map((p, i) => (i === idx ? '{lang}' : p)).join('/');
    const m = patterns.get(pat) ?? {};
    m[lang] = rel;
    patterns.set(pat, m);
  }
  const best = [...patterns.entries()].filter(([, m]) => Object.keys(m).length >= 2)
    .sort((a, b) => Object.keys(b[1]).length - Object.keys(a[1]).length)[0];
  if (best) {
    cfg.locales = best[1];
    cfg.baseLocale = 'en' in best[1] ? 'en' : Object.keys(best[1])[0];
  }
  return cfg;
}

/** Run the analysis. Returns a report object (no printing, no process exit). */
export function analyze(root, cfg) {
  const locales = {};
  const raws = {};
  for (const [lang, spec] of Object.entries(cfg.locales)) {
    const list = Array.isArray(spec) ? spec : [spec];
    raws[lang] = {};
    for (const file of list) {
      const full = path.join(root, file);
      if (!fs.existsSync(full)) throw new Error(`locale file missing: ${file}`);
      try {
        Object.assign(raws[lang], JSON.parse(fs.readFileSync(full, 'utf8')));
      } catch (e) {
        throw new Error(`${file} is not valid JSON — ${e.message}`);
      }
    }
    locales[lang] = flatten(raws[lang]);
  }
  const langs = Object.keys(locales);
  if (!langs.length) throw new Error('no locales configured (run `i18n-guard init`)');
  const base = cfg.baseLocale in locales ? cfg.baseLocale : langs[0];

  const files = cfg.sourceDirs.flatMap((d) => walk(path.join(root, d), { exts: cfg.extensions, ignoreDirs: cfg.ignoreDirs }));
  const names = cfg.callNames.map(esc).join('|');
  const staticCall = new RegExp(`(?<![\\w$])(?:${names})\\(\\s*(['"\`])([^'"\`\\n$]+)\\1\\s*(,[^)]{0,300})?`, 'g');
  const dynamicCall = new RegExp(`(?<![\\w$])(?:${names})\\(\\s*\`([^\`$]*)\\$\\{`, 'g');
  const dotTr = /(['"])([A-Za-z0-9_.\-]+)\1\.tr\(/g;
  const hasDefaultText = (rest) => !!rest && (/defaultValue|\bfallback\b/.test(rest) || /^\s*,\s*(['"`])/.test(rest));

  const used = new Map();
  const dynamic = new Map();
  const addUse = (key, hasDefault, where) => {
    const u = used.get(key) ?? { hasDefault: false, where: [] };
    u.hasDefault = u.hasDefault || hasDefault;
    if (u.where.length < 5) u.where.push(where);
    used.set(key, u);
  };
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const rel = path.relative(root, f).replace(/\\/g, '/');
    for (const m of text.matchAll(staticCall)) addUse(m[2], hasDefaultText(m[3]), `${rel}:${lineOf(text, m.index)}`);
    for (const m of text.matchAll(dynamicCall)) {
      const p = m[1].replace(/\.$/, '');
      if (p) dynamic.set(p, [...(dynamic.get(p) ?? []), `${rel}:${lineOf(text, m.index)}`].slice(0, 5));
    }
    if (cfg.dotTrSuffix) for (const m of text.matchAll(dotTr)) addUse(m[2], false, `${rel}:${lineOf(text, m.index)}`);
  }

  const skip = (k) =>
    cfg.ignoreKeys.includes(k) || cfg.ignorePrefixes.some((p) => k.startsWith(p)) || (cfg.requireDot && !k.includes('.') && !(k in locales[base]));

  const report = { project: path.basename(root), scannedFiles: files.length, keysUsed: 0, locales: langs, baseLocale: base, errors: [], warnings: [], info: [] };
  const err = (type, key, extra = {}) => report.errors.push({ type, key, ...extra });
  const warn = (type, key, extra = {}) => report.warnings.push({ type, key, ...extra });

  for (const [key, u] of [...used].sort(([a], [b]) => a.localeCompare(b))) {
    if (skip(key)) continue;
    report.keysUsed++;
    for (const lang of langs) {
      if (key in locales[lang] || getPath(raws[lang], key) !== undefined) continue;
      (u.hasDefault ? warn : err)(u.hasDefault ? 'missing-with-default' : 'missing', key, { locale: lang, where: u.where });
    }
  }
  for (const lang of langs) {
    if (lang === base) continue;
    for (const key of Object.keys(locales[base])) {
      if (!(key in locales[lang])) warn('untranslated', key, { locale: lang, baseValue: locales[base][key] });
    }
  }
  const tokens = (s) => (typeof s === 'string' ? (s.match(/\{\{\s*[\w.]+\s*\}\}|\{[\w.]*\}/g) ?? []).map((x) => x.replace(/\s+/g, '')).sort().join('|') : '');
  for (const key of Object.keys(locales[base])) {
    const t0 = tokens(locales[base][key]);
    for (const lang of langs) {
      if (lang === base || !(key in locales[lang])) continue;
      const t1 = tokens(locales[lang][key]);
      if (t0 !== t1) warn('placeholder-mismatch', key, { locale: lang, base: t0 || '(none)', other: t1 || '(none)' });
    }
  }
  for (const lang of langs) {
    for (const [key, v] of Object.entries(locales[lang])) {
      if (v === '' || v === key) warn(v === '' ? 'empty-value' : 'value-equals-key', key, { locale: lang });
    }
  }
  for (const [prefix, where] of dynamic) {
    for (const lang of langs) {
      const node = getPath(raws[lang], prefix);
      if (!node || typeof node !== 'object') warn('dynamic-group-missing', `${prefix}.*`, { locale: lang, where });
    }
  }
  const usedKeys = new Set(used.keys());
  const dynPrefixes = [...dynamic.keys()];
  for (const key of Object.keys(locales[base])) {
    if (usedKeys.has(key) || dynPrefixes.some((p) => key.startsWith(p + '.'))) continue;
    report.info.push({ type: 'unused', key });
  }
  report.used = Object.fromEntries([...used].map(([k, v]) => [k, v]));
  return report;
}

/** Nested JSON skeleton of every missing key, per locale, ready to paste into the locale files. */
export function buildTemplate(report) {
  const out = {};
  for (const x of [...report.errors, ...report.warnings].filter((x) => x.type === 'missing' || x.type === 'missing-with-default')) {
    const o = (out[x.locale] ??= {});
    const parts = x.key.split('.');
    let n = o;
    parts.slice(0, -1).forEach((p) => { n = typeof n[p] === 'object' && n[p] ? n[p] : (n[p] = {}); });
    n[parts[parts.length - 1]] = '';
  }
  return out;
}

export const TITLES = {
  missing: 'ERROR  used in code, missing in locale, no default text (UI shows the raw key)',
  'missing-with-default': 'WARN   missing in locale, code has a default text',
  untranslated: 'WARN   in base locale but not translated',
  'placeholder-mismatch': 'WARN   placeholders differ between locales',
  'dynamic-group-missing': 'WARN   dynamic key group does not exist',
  'empty-value': 'WARN   empty value',
  'value-equals-key': 'WARN   value equals its key',
  unused: 'INFO   unused keys',
};
