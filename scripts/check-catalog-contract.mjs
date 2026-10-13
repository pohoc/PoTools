#!/usr/bin/env node
/**
 * CAT-01 (UI half): the catalog ↔ i18n contract gate.
 *
 * `packages/core/catalog/*.json` is the single source of tool metadata, and
 * every user-visible string in it is an i18n key that must resolve in BOTH
 * message tables. Nothing used to prove that mechanically: a renamed or missing
 * key renders as the raw key inside the app, and only shows up when a human
 * happens to open that tool in that locale.
 *
 * What this script checks (the parts that need the `apps/web` files):
 *   1. every catalog JSON on disk is embedded by `packages/core/src/tools.rs`
 *      (and every `include_str!` there still points at a real file), so a new
 *      domain file cannot be added without joining the registry;
 *   2. every string value under a `*Key` property (`nameKey`, `descKey`,
 *      `labelKey`, `descriptionKey`, `placeholderKey`, `suffixKey`, preset and
 *      option keys alike) exists in `apps/web/src/i18n/zh-CN.ts` and in
 *      `apps/web/src/i18n/en.ts`;
 *   3. the two message tables declare exactly the same key sets, so an English
 *      string cannot be added without its Chinese counterpart (and the
 *      reverse), independently of the TypeScript typing.
 *
 * Schema/shape checks (tool id uniqueness, field key uniqueness, `default`
 * versus declared `type`, `showIf` cross-references, stable option ids) live in
 * `packages/core/tests/catalog_contract.rs` — that is where the catalog is
 * parsed — and run through `pnpm rust:test`. Do not duplicate them here.
 *
 * Message tables are read as text rather than imported: the repo declares Node
 * `^20.19.0 || >=22.12.0` and only the newer ones can import TypeScript, so a
 * text scan keeps this gate deterministic on every supported runtime.
 *
 * Usage: node scripts/check-catalog-contract.mjs
 * Exit:  0 when the contract holds, 1 with file / tool / field-level findings.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_DIR = path.join(root, 'packages/core/catalog');
const TOOLS_RS = path.join(root, 'packages/core/src/tools.rs');
const MESSAGE_FILES = {
  'zh-CN': path.join(root, 'apps/web/src/i18n/zh-CN.ts'),
  en: path.join(root, 'apps/web/src/i18n/en.ts'),
};

/**
 * Files under `catalog/` that are option data for a tool rather than a tool
 * list, so they are not expected in `tools.rs`. `id-photo.json` holds the ID
 * photo presets consumed by `packages/core/src/id_photo.rs`.
 */
const NON_CATALOG_FILES = new Set(['id-photo.json']);

const findings = [];

/** Collect one finding with the file, tool and property path it belongs to. */
function finding(file, tool, subject, problem) {
  findings.push(`${relative(file)} > tool '${tool}' > ${subject}: ${problem}`);
}

function relative(file) {
  return path.relative(root, file);
}

/**
 * String-aware scan of a message table: any quoted string followed by `:` is a
 * key. Comments and string escapes are skipped so prose cannot fake a key, and
 * a value is never mistaken for a key because the character after it is `,`.
 */
function scanMessageKeys(source) {
  const keys = new Map();
  const length = source.length;
  let index = 0;
  while (index < length) {
    const char = source[index];
    if (char === '/' && source[index + 1] === '/') {
      const newline = source.indexOf('\n', index);
      index = newline === -1 ? length : newline + 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      const closed = source.indexOf('*/', index + 2);
      index = closed === -1 ? length : closed + 2;
      continue;
    }
    if (char !== '"' && char !== "'" && char !== '`') {
      index += 1;
      continue;
    }
    const start = index;
    let value = '';
    index += 1;
    while (index < length) {
      const current = source[index];
      if (current === '\\') {
        value += source.slice(index, index + 2);
        index += 2;
        continue;
      }
      if (current === char) break;
      if (current === '\n') break;
      value += current;
      index += 1;
    }
    const after = index < length ? index + 1 : length;
    let probe = after;
    while (probe < length && /\s/.test(source[probe])) probe += 1;
    if (source[probe] === ':' && source[probe + 1] !== ':' && source[probe + 1] !== '=') {
      if (!keys.has(value)) keys.set(value, start);
    }
    index = after;
  }
  return keys;
}

/** Every `*Key` string in a catalog value, with the property path it sits on. */
function collectKeys(node, trail, tool, file, expectKeys = false) {
  const collected = [];
  if (Array.isArray(node)) {
    node.forEach((item, index) => {
      // A `*Key` / `*Keys` / `*KeyList` property carries message ids in array
      // elements too (`placeholderKeyList` on the id-photo presets); skipping
      // plain strings there left whole groups of references unchecked.
      if (expectKeys && typeof item === 'string') {
        collected.push({ file, tool, subject: `${trail}[${index}]`, value: item });
        return;
      }
      collected.push(...collectKeys(item, `${trail}[${index}]`, tool, file));
    });
    return collected;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      const keyProp = /Keys?$/.test(key) || /KeyList$/.test(key);
      if (typeof value === 'string' && /Key$/.test(key)) {
        collected.push({ file, tool, subject: `${trail || '<root>'}.${key}`, value });
        continue;
      }
      collected.push(
        ...collectKeys(value, trail ? `${trail}.${key}` : key, tool, file, keyProp && Array.isArray(value)),
      );
    }
  }
  return collected;
}

function readJson(file) {
  try {
    return { value: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (error) {
    return { error: `invalid JSON: ${error.message}` };
  }
}

/** The catalog file names `tools.rs` embeds, in declaration order. */
function embeddedCatalogFiles(source) {
  const names = [];
  const pattern = /include_str!\("\.\.\/catalog\/([^"]+\.json)"\)/g;
  let match;
  while ((match = pattern.exec(source)) !== null) names.push(match[1]);
  return names;
}

const tables = {};
for (const [locale, file] of Object.entries(MESSAGE_FILES)) {
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch (error) {
    console.error(`[catalog:check] cannot read ${relative(file)}: ${error.message}`);
    process.exit(1);
  }
  tables[locale] = scanMessageKeys(source);
  console.log(`[catalog:check] ${relative(file)} declares ${tables[locale].size} message keys`);
}

// 3. the two tables must describe the same key set.
const [firstLocale, secondLocale] = Object.keys(tables);
const first = tables[firstLocale];
const second = tables[secondLocale];
const onlyFirst = [...first.keys()].filter((key) => !second.has(key)).sort();
const onlySecond = [...second.keys()].filter((key) => !first.has(key)).sort();
for (const key of onlyFirst) {
  findings.push(`${relative(MESSAGE_FILES[firstLocale])}: '${key}' has no entry in ${relative(MESSAGE_FILES[secondLocale])}`);
}
for (const key of onlySecond) {
  findings.push(`${relative(MESSAGE_FILES[secondLocale])}: '${key}' has no entry in ${relative(MESSAGE_FILES[firstLocale])}`);
}

// 1. disk ↔ tools.rs embedding reconciliation.
const onDisk = readdirSync(CATALOG_DIR)
  .filter((name) => name.endsWith('.json') && !NON_CATALOG_FILES.has(name))
  .sort();
const embedded = embeddedCatalogFiles(readFileSync(TOOLS_RS, 'utf8'));
const embeddedSet = new Set(embedded);
const diskSet = new Set(onDisk);
for (const entry of onDisk.filter((candidate) => !embeddedSet.has(candidate))) {
  findings.push(
    `${relative(path.join(CATALOG_DIR, entry))}: not embedded by ${relative(TOOLS_RS)}, ` +
      'so its tools are missing from the registry',
  );
}
for (const entry of embedded.filter((candidate) => !diskSet.has(candidate))) {
  findings.push(
    `${relative(TOOLS_RS)}: include_str! references catalog/${entry}, which does not exist on disk`,
  );
}
if (embedded.length !== embeddedSet.size) {
  findings.push(`${relative(TOOLS_RS)}: the same catalog file is embedded more than once`);
}

// 2. every catalog `*Key` resolves in both tables.
let toolCount = 0;
let keyCount = 0;
const referenced = new Set();
for (const name of onDisk) {
  const file = path.join(CATALOG_DIR, name);
  const { value: tools, error } = readJson(file);
  if (error) {
    findings.push(`${relative(file)}: ${error}`);
    continue;
  }
  if (!Array.isArray(tools)) {
    findings.push(`${relative(file)}: expected an array of tools, found ${typeof tools}`);
    continue;
  }
  toolCount += tools.length;
  for (const tool of tools) {
    const id = typeof tool?.id === 'string' && tool.id !== '' ? tool.id : '(missing id)';
    for (const entry of collectKeys(tool, '', id, file)) {
      keyCount += 1;
      referenced.add(entry.value);
      for (const [locale, table] of Object.entries(tables)) {
        if (!table.has(entry.value)) {
          finding(entry.file, entry.tool, entry.subject, `'${entry.value}' is not in ${relative(MESSAGE_FILES[locale])}`);
        }
      }
    }
  }
}

const uniqueKeys = referenced.size;
if (findings.length > 0) {
  console.error(`\n[catalog:check] ${findings.length} finding(s) across ${toolCount} tool(s):`);
  for (const line of findings) console.error(`  - ${line}`);
  console.error(
    '\n[catalog:check] FAIL — for a missing message key, add it to BOTH ' +
      'apps/web/src/i18n/zh-CN.ts and apps/web/src/i18n/en.ts (or fix the reference in the ' +
      'catalog); for an embedding finding, add or remove the include_str! in ' +
      'packages/core/src/tools.rs and run `pnpm rust:test` for the schema checks.',
  );
  process.exit(1);
}
console.log(
  `[catalog:check] OK — ${onDisk.length} catalog file(s), ${toolCount} tool(s), ` +
    `${keyCount} key reference(s) (${uniqueKeys} distinct) resolved in both locales; ` +
    `${embedded.length} embedded catalog(s) reconciled with disk.`,
);
