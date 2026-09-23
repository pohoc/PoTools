import type { ToolContext } from '../types.ts';
import { commonMessages } from './messages/common.ts';
import { cryptoEncodingMessages } from './messages/crypto-encoding.ts';
import { cryptoPrimitivesMessages } from './messages/crypto-primitives.ts';
import { timeMessages } from './messages/time.ts';
import { timeExtraMessages } from './messages/time-extra.ts';
import { developerMessages } from './messages/developer.ts';
import { financeMessages } from './messages/finance.ts';
import { ocrMessages } from './messages/ocr.ts';

export type MsgLocale = 'zh-CN' | 'en';

export interface DomainMessages {
  'zh-CN': Record<string, string>;
  en: Record<string, string>;
}

const CATALOGS: readonly DomainMessages[] = [
  commonMessages,
  timeMessages,
  timeExtraMessages,
  developerMessages,
  cryptoEncodingMessages,
  cryptoPrimitivesMessages,
  financeMessages,
  ocrMessages,
];

function merge(locale: MsgLocale): Record<string, string> {
  const table: Record<string, string> = {};
  for (const catalog of CATALOGS) Object.assign(table, catalog[locale]);
  return table;
}

const TABLES: Record<MsgLocale, Record<string, string>> = {
  'zh-CN': merge('zh-CN'),
  en: merge('en'),
};

const TOKEN = /\{([A-Za-z0-9_.$-]+)\}/g;

function lookup(locale: MsgLocale, key: string): string {
  return TABLES[locale][key] ?? TABLES['zh-CN'][key] ?? TABLES.en[key] ?? key;
}

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(TOKEN, (token, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : token,
  );
}

export function normalizeLocale(input: unknown): MsgLocale {
  return typeof input === 'string' && input.trim().toLowerCase().startsWith('en') ? 'en' : 'zh-CN';
}

export function localeOf(ctx: Pick<ToolContext, 'globals'>): MsgLocale {
  return normalizeLocale(ctx.globals?.locale);
}

export function translate(locale: MsgLocale, key: string, params?: Record<string, string | number>): string {
  return interpolate(lookup(locale, key), params);
}

export function makeMsg(input: unknown): (key: string, params?: Record<string, string | number>) => string {
  const locale = normalizeLocale(input);
  return (key, params) => translate(locale, key, params);
}
