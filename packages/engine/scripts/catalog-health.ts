/** Catalog health: per-table key counts, zh/en parity, duplicate zh values. */
import type { DomainMessages } from '../src/lib/messages.ts';
import { commonMessages } from '../src/lib/messages/common.ts';
import { cryptoEncodingMessages } from '../src/lib/messages/crypto-encoding.ts';
import { cryptoPrimitivesMessages } from '../src/lib/messages/crypto-primitives.ts';
import { timeMessages } from '../src/lib/messages/time.ts';

const TABLES: Array<[string, DomainMessages]> = [
  ['common', commonMessages],
  ['time', timeMessages],
  ['crypto-encoding', cryptoEncodingMessages],
  ['crypto-primitives', cryptoPrimitivesMessages],
];

let problems = 0;

for (const [name, catalog] of TABLES) {
  const zh = Object.keys(catalog['zh-CN']);
  const en = Object.keys(catalog.en);
  const zhOnly = zh.filter((key) => !en.includes(key));
  const enOnly = en.filter((key) => !zh.includes(key));
  process.stdout.write(
    `${name.padEnd(17)} zh=${String(zh.length).padStart(4)} en=${String(en.length).padStart(4)} parity=${zhOnly.length + enOnly.length ? 'MISMATCH' : 'ok'}\n`,
  );
  if (zhOnly.length) {
    problems += 1;
    process.stdout.write(`  zh-only keys: ${zhOnly.join(', ')}\n`);
  }
  if (enOnly.length) {
    problems += 1;
    process.stdout.write(`  en-only keys: ${enOnly.join(', ')}\n`);
  }
}

const merged = new Map<string, Array<[string, string, string]>>();
for (const [name, catalog] of TABLES) {
  for (const [key, value] of Object.entries(catalog['zh-CN'])) {
    const entry = merged.get(value) ?? [];
    entry.push([key, name, catalog.en[key] ?? '(missing en)']);
    merged.set(value, entry);
  }
}
const groups = [...merged.entries()].filter(([, keys]) => keys.length > 1);
const redundant = groups.reduce((sum, [, keys]) => sum + keys.length - 1, 0);
const identical = groups.filter(([, keys]) => new Set(keys.map(([, , en]) => en)).size === 1);
process.stdout.write(
  `\nmerged keys=${merged.size} duplicate-zh groups=${groups.length} redundant keys=${redundant} safe to merge (en identical too)=${identical.length}\n`,
);
for (const [zhValue, keys] of groups) {
  const enValues = new Set(keys.map(([, , en]) => en));
  const show = zhValue.length > 24 ? `${zhValue.slice(0, 24)}…` : zhValue;
  process.stdout.write(
    `  [${enValues.size === 1 ? 'MERGEABLE' : 'EN-DIFFERS'}] 「${show}」\n${keys.map(([key, table, en]) => `      ${table}:${key} → "${en}"`).join('\n')}\n`,
  );
}
process.exitCode = problems ? 1 : 0;
