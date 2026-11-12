# i18n-guard

A zero-dependency command line tool that finds translation problems **before** users see them:
keys the code uses but the locale files don't have (the UI then shows the raw key, like `common.notFound`),
untranslated keys, mismatched placeholders and unused keys.

Works with **i18next / react-i18next / vue-i18n** (`t('a.b')`) and **Flutter easy_localization**
(`tr('a.b')`, `'a.b'.tr()`). Needs Node 18+.

## Quick start

```bash
# 1. let it detect your project and write i18n-guard.config.json
npx github:MoazReactTsx/i18n-guard init

# 2. check
npx github:MoazReactTsx/i18n-guard
```

Or install it as a dev dependency straight from GitHub, then use the short `i18n-guard` command:

```bash
npm i -D github:MoazReactTsx/i18n-guard
npx i18n-guard init
```

The exit code is `1` when something would show up as a raw key, so it fits CI and `prebuild` hooks:

```json
{
  "scripts": {
    "i18n:check": "i18n-guard",
    "prebuild": "i18n-guard"
  }
}
```

## What it reports

| Level | Meaning |
|---|---|
| **ERROR** | key used in code, missing in a locale, and no default text → the UI shows the raw key |
| WARN | key missing but the code passes a default text (`t('a.b', 'Default')` / `{ defaultValue }`) |
| WARN | key in the base locale that is missing in another locale (untranslated) |
| WARN | placeholders differ between locales (`{{name}}` vs `{name}`) |
| WARN | dynamic key such as ``t(`status.${s}`)`` whose group `status` does not exist |
| WARN | empty value, or a value equal to its own key |
| INFO | unused keys (with `--unused`) |

## Commands and options

```
i18n-guard [check]                 scan and report
i18n-guard init [--force]          detect the project, write i18n-guard.config.json
i18n-guard check --strict          also fail on keys that only have a default text
i18n-guard check --unused          also list keys nothing uses
i18n-guard check --json            JSON report on stdout
i18n-guard check --out report.json write the full JSON report
i18n-guard check --md report.md    write a Markdown report
i18n-guard check --template t.json write a skeleton of the missing keys per locale (paste into your locale files)
i18n-guard check --watch           re-run on every change
--config <file>   use another config     --cwd <dir>   run against another folder
```

## Configuration (`i18n-guard.config.json`)

```json
{
  "sourceDirs": ["src"],
  "extensions": [".ts", ".tsx"],
  "locales": { "en": "src/locales/en.json", "ar": "src/locales/ar.json" },
  "baseLocale": "en",
  "requireDot": true,
  "callNames": ["t"],
  "dotTrSuffix": false,
  "ignoreKeys": [],
  "ignorePrefixes": []
}
```

| Field | Default | Notes |
|---|---|---|
| `sourceDirs` | `["src"]` | folders to scan |
| `extensions` | `[".ts",".tsx",".js",".jsx"]` | file types to scan |
| `locales` | – | `{ lang: "file.json" }` — a value may also be an array of files that are merged |
| `baseLocale` | `"en"` | the reference language; others are compared against it |
| `requireDot` | `true` | ignore keys without a `.` (avoids false hits such as `t('Cancel')`); use `false` for flat keys |
| `callNames` | `["t"]` | functions that translate, e.g. `["t", "$t", "i18n.t"]` |
| `dotTrSuffix` | `false` | also match `'key'.tr()` (Flutter) |
| `ignoreKeys` / `ignorePrefixes` | `[]` | skip exact keys / prefixes |
| `ignoreDirs` | `node_modules, dist, build, .git, coverage` | folders never scanned |

### Flutter (easy_localization)

```json
{
  "sourceDirs": ["lib"],
  "extensions": [".dart"],
  "locales": { "en": "assets/translations/en.json", "ar": "assets/translations/ar.json" },
  "callNames": ["tr"],
  "dotTrSuffix": true,
  "requireDot": false
}
```

`i18n-guard init` writes this for you when it finds a `pubspec.yaml`.

## Use it as a library

```js
import { analyze, loadConfig } from 'i18n-guard';

const { cfg } = loadConfig(process.cwd());
const report = analyze(process.cwd(), cfg);
console.log(report.errors);
```

## Limits

- Only **static** keys are checked. Dynamic ones (``t(`a.${x}`)``) are checked for the parent group only.
- Keys are found by pattern, not by parsing the code, so a call written in an unusual way may be missed.
- i18next **namespaces** (`t('ns:key')`, one file per namespace) are not resolved; merge the namespace files
  in the `locales` array if you want them checked as one set.
- It checks that keys exist, not that translations are correct.

## Development

```bash
npm test
```

## License

MIT
