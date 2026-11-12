import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { analyze, buildTemplate, detectConfig, DEFAULTS } from '../src/core.mjs';

const CLI = path.resolve('bin/i18n-guard.mjs');

function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-guard-'));
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

const cfg = (extra = {}) => ({ ...DEFAULTS, locales: { en: 'locales/en.json', ar: 'locales/ar.json' }, ...extra });

test('reports a key that is used but missing (error) and one with a default text (warning)', () => {
  const dir = project({
    'src/a.tsx': "t('common.save'); t('common.notFound'); t('common.edit', { defaultValue: 'Edit' });",
    'locales/en.json': { common: { save: 'Save' } },
    'locales/ar.json': { common: { save: 'حفظ' } },
  });
  const r = analyze(dir, cfg());
  assert.deepEqual(r.errors.map((e) => `${e.locale}:${e.key}`).sort(), ['ar:common.notFound', 'en:common.notFound']);
  assert.deepEqual(r.warnings.filter((w) => w.type === 'missing-with-default').map((w) => w.key), ['common.edit', 'common.edit']);
});

test('finds keys missing from one locale only, and placeholder mismatches', () => {
  const dir = project({
    'src/a.ts': "t('a.hello'); t('a.count');",
    'locales/en.json': { a: { hello: 'Hello {{name}}', count: '{{n}} items' } },
    'locales/ar.json': { a: { hello: 'مرحبا' } },
  });
  const r = analyze(dir, cfg());
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].locale, 'ar');
  assert.ok(r.warnings.some((w) => w.type === 'placeholder-mismatch' && w.key === 'a.hello'));
});

test('dynamic keys: warns when the parent group is missing, ignores the rest', () => {
  const dir = project({
    'src/a.tsx': 'const x = t(`status.${s}`); const y = t(`other.${s}`);',
    'locales/en.json': { status: { on: 'On' } },
    'locales/ar.json': { status: { on: 'تشغيل' } },
  });
  const r = analyze(dir, cfg());
  assert.deepEqual(r.warnings.filter((w) => w.type === 'dynamic-group-missing').map((w) => w.key), ['other.*', 'other.*']);
  assert.equal(r.errors.length, 0);
});

test('ignores keys without a dot when requireDot is on, and honours ignorePrefixes', () => {
  const dir = project({
    'src/a.ts': "t('Cancel'); t('skip.me'); t('real.one');",
    'locales/en.json': { real: { one: '1' } },
    'locales/ar.json': { real: { one: '١' } },
  });
  const r = analyze(dir, cfg({ ignorePrefixes: ['skip.'] }));
  assert.equal(r.errors.length, 0);
});

test('flutter style: tr() and .tr() calls with flat keys', () => {
  const dir = project({
    'lib/a.dart': "Text(tr('hello')); Text('bye'.tr()); Text('ok'.tr());",
    'locales/en.json': { hello: 'Hello', ok: 'OK' },
    'locales/ar.json': { hello: 'مرحبا', ok: 'تمام' },
  });
  const r = analyze(dir, cfg({ sourceDirs: ['lib'], extensions: ['.dart'], callNames: ['tr'], dotTrSuffix: true, requireDot: false }));
  assert.deepEqual(r.errors.map((e) => e.key), ['bye', 'bye']);
});

test('template lists the missing keys as nested JSON per locale', () => {
  const dir = project({
    'src/a.ts': "t('x.y.z');",
    'locales/en.json': {},
    'locales/ar.json': {},
  });
  const tpl = buildTemplate(analyze(dir, cfg()));
  assert.deepEqual(tpl, { en: { x: { y: { z: '' } } }, ar: { x: { y: { z: '' } } } });
});

test('init detects the locale files and the CLI exits 1 on errors, 0 when clean', () => {
  const dir = project({
    'package.json': '{}',
    'src/a.ts': "t('a.b');",
    'src/locales/en.json': { a: { b: 'B' } },
    'src/locales/ar.json': { a: { b: 'ب' } },
  });
  const detected = detectConfig(dir);
  assert.deepEqual(detected.locales, { en: 'src/locales/en.json', ar: 'src/locales/ar.json' });

  assert.equal(spawnSync('node', [CLI, 'init', '--cwd', dir]).status, 0);
  assert.equal(spawnSync('node', [CLI, '--cwd', dir]).status, 0);

  fs.appendFileSync(path.join(dir, 'src/b.ts'), "t('a.missing');");
  assert.equal(spawnSync('node', [CLI, '--cwd', dir]).status, 1);
});

test('init also finds i18next-style locales/<lang>/translation.json', () => {
  const dir = project({
    'package.json': '{}',
    'src/locales/en/translation.json': { a: 'A' },
    'src/locales/ar/translation.json': { a: 'ا' },
  });
  assert.deepEqual(detectConfig(dir).locales, { en: 'src/locales/en/translation.json', ar: 'src/locales/ar/translation.json' });
});
