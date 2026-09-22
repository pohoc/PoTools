/** Catalog health: per-table key counts, zh/en parity, duplicate zh values. */
import type { DomainMessages } from '../src/lib/messages.ts';
import { commonMessages } from '../src/lib/messages/common.ts';
import { cryptoEncodingMessages } from '../src/lib/messages/crypto-encoding.ts';
import { cryptoPrimitivesMessages } from '../src/lib/messages/crypto-primitives.ts';
import { timeMessages } from '../src/lib/messages/time.ts';
import { defaultOptions, TOOL_LIST, TOOLS } from '../../core/src/tools.ts';
import { TOOL_IMPL_MAP } from '../src/tools/index.ts';

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

// The desktop uses one generic ToolPage route for every normal descriptor and
// one RPC-backed page for the invoice organizer. Keep this contract close to
// the catalog so a new tool cannot silently ship without a route or runner.
const SPECIAL_RPC_TOOLS = new Set(['invoice-organize']);
const LAYOUTS = new Set(['standard', 'organizer', 'splitter', 'metadata', 'image-grid', 'text']);
const catalogProblems: string[] = [];
const catalogIssue = (message: string): void => {
  catalogProblems.push(message);
};
const descriptorIds = new Set<string>();

for (const descriptor of TOOL_LIST) {
  if (descriptorIds.has(descriptor.id)) catalogIssue(`${descriptor.id}: duplicate descriptor id`);
  descriptorIds.add(descriptor.id);
  if (TOOLS[descriptor.id] !== descriptor) catalogIssue(`${descriptor.id}: TOOLS index does not reference descriptor`);
  if (!descriptor.nameKey || !descriptor.descKey || !descriptor.accept || !descriptor.icon) catalogIssue(`${descriptor.id}: incomplete route descriptor`);
  if ((!descriptor.inputFormats.length && descriptor.accept !== '*/*') || !descriptor.outputFormats.length) catalogIssue(`${descriptor.id}: missing input/output format`);
  if (!LAYOUTS.has(descriptor.layout)) catalogIssue(`${descriptor.id}: unsupported layout ${descriptor.layout}`);

  const fields = new Set<string>();
  for (const field of descriptor.fields) {
    if (fields.has(field.key)) catalogIssue(`${descriptor.id}: duplicate field ${field.key}`);
    fields.add(field.key);
    if (field.showIf && !descriptor.fields.some((candidate) => candidate.key === field.showIf?.field)) {
      catalogIssue(`${descriptor.id}.${field.key}: showIf references missing field ${field.showIf.field}`);
    }
    if ((field.type === 'select' && field.options.length === 0) || (field.type === 'slider' && field.step <= 0)) {
      catalogIssue(`${descriptor.id}.${field.key}: invalid field options`);
    }
    if ('min' in field && 'max' in field && field.min !== undefined && field.max !== undefined && field.min > field.max) {
      catalogIssue(`${descriptor.id}.${field.key}: min exceeds max`);
    }
    if ('min' in field && 'max' in field && typeof field.default === 'number' && field.min !== undefined && field.max !== undefined && (field.default < field.min || field.default > field.max)) {
      catalogIssue(`${descriptor.id}.${field.key}: default is outside range`);
    }
  }
  const defaults = defaultOptions(descriptor.id);
  for (const key of Object.keys(defaults)) if (!fields.has(key)) catalogIssue(`${descriptor.id}: default has unknown field ${key}`);
  for (const key of fields) if (!(key in defaults)) catalogIssue(`${descriptor.id}: missing default for field ${key}`);

  const hasRunner = descriptor.id in TOOL_IMPL_MAP;
  const hasSpecialRoute = SPECIAL_RPC_TOOLS.has(descriptor.id);
  if (!hasRunner && !hasSpecialRoute) catalogIssue(`${descriptor.id}: missing engine runner and special route`);
  if (hasSpecialRoute && descriptor.id !== 'invoice-organize') catalogIssue(`${descriptor.id}: unknown special route`);
}

for (const id of Object.keys(TOOL_IMPL_MAP)) {
  if (!descriptorIds.has(id) && !SPECIAL_RPC_TOOLS.has(id)) catalogIssue(`engine runner ${id}: missing descriptor`);
}

const layoutCounts = TOOL_LIST.reduce<Record<string, number>>((counts, descriptor) => {
  counts[descriptor.layout] = (counts[descriptor.layout] ?? 0) + 1;
  return counts;
}, {});
process.stdout.write(
  `\nUI/descriptor contract: tools=${TOOL_LIST.length} routes=${descriptorIds.size} runners=${Object.keys(TOOL_IMPL_MAP).length} specialRoutes=${SPECIAL_RPC_TOOLS.size} layouts=${Object.entries(layoutCounts).map(([layout, count]) => `${layout}:${count}`).join(', ')} problems=${catalogProblems.length}\n`,
);
for (const problem of catalogProblems) process.stdout.write(`  ${problem}\n`);
problems += catalogProblems.length;
process.exitCode = problems ? 1 : 0;
