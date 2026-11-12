#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { analyze, buildTemplate, detectConfig, loadConfig, TITLES } from '../src/core.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'check';
const root = path.resolve(val('--cwd') ?? process.cwd());

const HELP = `i18n-guard — find translation keys the code uses but the locale files do not have

Usage
  i18n-guard [check]            scan the project and report (exit 1 on errors)
  i18n-guard init               detect the project and write i18n-guard.config.json
  i18n-guard check --strict     also fail on keys that only have a default text in the code
  i18n-guard check --unused     also list locale keys nothing uses
  i18n-guard check --json       print the report as JSON
  i18n-guard check --out f.json write the full JSON report to a file
  i18n-guard check --md f.md    write a Markdown report to a file
  i18n-guard check --template f.json   write a skeleton of the missing keys, per locale
  i18n-guard check --watch      re-run when a source or locale file changes
Options
  --config <file>   use a specific config file     --cwd <dir>   run against another folder
Supports i18next / react-i18next / vue-i18n (t('a.b')) and Flutter easy_localization (tr('a.b'), 'a.b'.tr()).`;

if (has('-h') || has('--help') || cmd === 'help') { console.log(HELP); process.exit(0); }

if (cmd === 'init') {
  const target = path.join(root, 'i18n-guard.config.json');
  if (fs.existsSync(target) && !has('--force')) { console.error('i18n-guard: i18n-guard.config.json already exists (use --force to overwrite)'); process.exit(2); }
  const cfg = detectConfig(root);
  const { ignoreDirs, ...rest } = cfg; // ignoreDirs keeps its default
  void ignoreDirs;
  fs.writeFileSync(target, JSON.stringify(rest, null, 2) + '\n');
  console.log('i18n-guard: wrote i18n-guard.config.json');
  console.log(JSON.stringify(rest, null, 2));
  if (!Object.keys(rest.locales).length) console.log('\n⚠ no locale files were detected — fill the "locales" map by hand.');
  console.log('\nNext: i18n-guard   (add  "i18n:check": "i18n-guard"  and  "prebuild": "i18n-guard"  to package.json scripts)');
  process.exit(0);
}

function run() {
  const loaded = loadConfig(root, val('--config'));
  if (!loaded) { console.error('i18n-guard: no config found. Run `i18n-guard init` first.'); return 2; }
  let report;
  try {
    report = analyze(root, loaded.cfg);
  } catch (e) {
    console.error('i18n-guard: ' + e.message);
    return 2;
  }
  const strict = has('--strict');
  const failing = report.errors.length + (strict ? report.warnings.filter((w) => w.type === 'missing-with-default').length : 0);
  report.ok = failing === 0;
  if (!has('--unused')) report.info = [];
  const { used, ...slim } = report;
  void used;

  const group = (list) => { const m = new Map(); for (const x of list) m.set(x.type, [...(m.get(x.type) ?? []), x]); return m; };
  const fmt = (x) => {
    const bits = [x.locale ? `[${x.locale}]` : '', x.key];
    if (x.where) bits.push('<= ' + x.where[0] + (x.where.length > 1 ? ` (+${x.where.length - 1})` : ''));
    if (x.type === 'placeholder-mismatch') bits.push(`base ${x.base} vs ${x.other}`);
    if (x.type === 'untranslated') bits.push(`(${String(x.baseValue).slice(0, 40)})`);
    return '  ' + bits.filter(Boolean).join(' ');
  };

  if (has('--json')) {
    console.log(JSON.stringify(slim, null, 2));
  } else {
    console.log(`i18n-guard — ${report.project}: ${report.scannedFiles} files, ${report.keysUsed} keys used, locales: ${report.locales.join(', ')} (base ${report.baseLocale})`);
    for (const list of [report.errors, report.warnings, report.info]) {
      for (const [type, items] of group(list)) {
        console.log(`\n${TITLES[type] ?? type} — ${items.length}`);
        const shown = type === 'untranslated' || type === 'unused' ? items.slice(0, 40) : items;
        shown.forEach((x) => console.log(fmt(x)));
        if (shown.length < items.length) console.log(`  … and ${items.length - shown.length} more (use --out report.json for the full list)`);
      }
    }
    console.log(`\n${report.ok ? '✔ OK' : '✘ FAILED'} — ${report.errors.length} error(s), ${report.warnings.length} warning(s)${strict ? ' (strict)' : ''}`);
  }
  if (val('--out')) fs.writeFileSync(path.join(root, val('--out')), JSON.stringify(slim, null, 2));
  if (val('--template')) fs.writeFileSync(path.join(root, val('--template')), JSON.stringify(buildTemplate(report), null, 2));
  if (val('--md')) {
    const lines = [`# i18n report — ${report.project}`, '', `Files: ${report.scannedFiles} · keys used: ${report.keysUsed} · locales: ${report.locales.join(', ')}`, ''];
    for (const [title, list] of [['Errors', report.errors], ['Warnings', report.warnings], ['Info', report.info]]) {
      if (!list.length) continue;
      lines.push(`## ${title}`, '');
      for (const [type, items] of group(list)) {
        lines.push(`### ${TITLES[type] ?? type} (${items.length})`, '');
        items.forEach((x) => lines.push('- `' + (x.locale ? `[${x.locale}] ` : '') + x.key + '`' + (x.where ? ' — ' + x.where[0] : '')));
        lines.push('');
      }
    }
    fs.writeFileSync(path.join(root, val('--md')), lines.join('\n'));
  }
  return report.ok ? 0 : 1;
}

if (has('--watch')) {
  const loaded = loadConfig(root, val('--config'));
  if (!loaded) { console.error('i18n-guard: no config found. Run `i18n-guard init` first.'); process.exit(2); }
  const dirs = [...loaded.cfg.sourceDirs, ...Object.values(loaded.cfg.locales).flat().map((f) => path.dirname(f))].map((d) => path.join(root, d));
  let timer;
  const again = () => { clearTimeout(timer); timer = setTimeout(() => { console.clear(); run(); console.log('\nwatching for changes… (Ctrl+C to stop)'); }, 250); };
  for (const d of new Set(dirs)) if (fs.existsSync(d)) fs.watch(d, { recursive: true }, again);
  again();
} else {
  process.exit(run());
}
