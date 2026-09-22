import { EngineError } from '../errors.ts';
import { makeMsg } from '../lib/messages.ts';
import type { MsgLocale } from '../lib/messages.ts';
import type { ToolContext } from '../types.ts';

export type { MsgLocale };

export const SEC_MS = 1000;
export const MIN_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
export const WEEK_MS = 604_800_000;
export const MONTH_MS = 2_629_800_000;
export const YEAR_MS = 31_557_600_000;
export const MAX_EPOCH_MS = 8.64e15;

export const WEEKDAYS_ZH = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
export const WEEKDAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const WEEKDAYS_EN_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const MONTHS_EN_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export type FlexUnit = 's' | 'ms' | 'us' | 'ns';
export type InputUnit = FlexUnit | 'auto';
export type LocaleCode = 'zh-CN' | 'en-US';

export interface TimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export interface ZonedParts extends TimeParts {
  epochMs: number;
  millisecond: number;
  timeZone: string;
  offsetMinutes: number;
  weekday: number;
  dayOfYear: number;
  daysInYear: number;
  isoYear: number;
  isoWeek: number;
  isoWeekday: number;
  abbrev: string;
  dst: boolean;
}

export interface PreciseInstant {
  date: Date;
  epochMs: number;
  epochUs: bigint;
  epochNs: bigint;
  unit: FlexUnit | 'text';
  sourceUnit: InputUnit;
  raw: string;
  exact: boolean;
}

export interface FlexOptions {
  timeZone?: string;
  fallbackNow?: number;
  field?: string;
  unit?: InputUnit;
}

export interface WallTime extends TimeParts {
  millisecond?: number;
}

export interface CalendarSpan {
  sign: 1 | -1 | 0;
  years: number;
  months: number;
  weeks: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  milliseconds: number;
}

export interface ShiftResult {
  epochMs: number;
  clamped: boolean;
  clampedFrom: number;
  clampedTo: number;
  adjusted: boolean;
}

const NS_PER_UNIT: Record<FlexUnit, bigint> = {
  s: 1_000_000_000n,
  ms: 1_000_000n,
  us: 1_000n,
  ns: 1n,
};


/* ── zone maths, no timezone database: everything derives from Intl parts ──── */

const zonedFormatters = new Map<string, Intl.DateTimeFormat>();
const abbrevFormatters = new Map<string, Intl.DateTimeFormat>();

function invalidZone(timeZone: string, field: string, locale: MsgLocale): EngineError {
  const t = makeMsg(locale);
  return new EngineError(
    'bad_request',
    t('core.error.invalidZone', { field, zone: timeZone || t('common.value.blank') }),
  );
}

export function assertTimeZone(
  timeZone: string | undefined,
  field = 'timezone',
  locale: MsgLocale = 'zh-CN',
): string {
  const name = (timeZone ?? '').trim();
  if (!name) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
  } catch {
    throw invalidZone(name, field, locale);
  }
  return name;
}

function zonedFormatter(timeZone: string, locale: MsgLocale): Intl.DateTimeFormat {
  const cached = zonedFormatters.get(timeZone);
  if (cached) return cached;
  let made: Intl.DateTimeFormat;
  try {
    made = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    throw invalidZone(timeZone, 'timezone', locale);
  }
  zonedFormatters.set(timeZone, made);
  return made;
}

function readParts(timeZone: string, epochMs: number, locale: MsgLocale): TimeParts {
  const fields = new Map(
    zonedFormatter(timeZone, locale)
      .formatToParts(new Date(epochMs))
      .map((part) => [part.type, part.value] as const),
  );
  return {
    year: Number(fields.get('year') ?? '1970'),
    month: Number(fields.get('month') ?? '1'),
    day: Number(fields.get('day') ?? '1'),
    hour: Number(fields.get('hour') ?? '0') % 24,
    minute: Number(fields.get('minute') ?? '0'),
    second: Number(fields.get('second') ?? '0'),
  };
}

export function zoneOffsetMinutes(timeZone: string, at: number | Date, locale: MsgLocale = 'zh-CN'): number {
  const epochMs = clampEpoch(at instanceof Date ? at.getTime() : at);
  const p = readParts(timeZone, epochMs, locale);
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - epochMs) / MIN_MS);
}

export function isDstActive(timeZone: string, at: number | Date, locale: MsgLocale = 'zh-CN'): boolean {
  const epochMs = at instanceof Date ? at.getTime() : at;
  const year = new Date(clampEpoch(epochMs)).getUTCFullYear();
  const current = zoneOffsetMinutes(timeZone, epochMs, locale);
  const winter = zoneOffsetMinutes(timeZone, Date.UTC(year, 0, 1), locale);
  const summer = zoneOffsetMinutes(timeZone, Date.UTC(year, 6, 1), locale);
  return current > Math.min(winter, summer);
}

export function zoneAbbrev(timeZone: string, at: number | Date, locale: MsgLocale = 'zh-CN'): string {
  const name = assertTimeZone(timeZone, 'timezone', locale);
  let made = abbrevFormatters.get(name);
  if (!made) {
    try {
      made = new Intl.DateTimeFormat('en-US', { timeZone: name, timeZoneName: 'short' });
    } catch {
      throw invalidZone(name, 'timezone', locale);
    }
    abbrevFormatters.set(name, made);
  }
  const part = made.formatToParts(at instanceof Date ? at : new Date(clampEpoch(at))).find((item) => item.type === 'timeZoneName');
  return part?.value ?? name;
}

export function offsetLabel(minutes: number, colon = true): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(Math.round(minutes));
  const hh = pad(Math.floor(abs / 60), 2);
  const mm = pad(abs % 60, 2);
  return `${sign}${hh}${colon ? ':' : ''}${mm}`;
}

export function zonedParts(timeZone: string, at: number | Date, locale: MsgLocale = 'zh-CN'): ZonedParts {
  const name = assertTimeZone(timeZone, 'timezone', locale);
  const epochMs = clampEpoch(at instanceof Date ? at.getTime() : at);
  const p = readParts(name, epochMs, locale);
  const calendar = Date.UTC(p.year, p.month - 1, p.day);
  const jan1 = Date.UTC(p.year, 0, 1);
  const daysInYear = isLeapYear(p.year) ? 366 : 365;
  const iso = isoWeekOf(p.year, p.month, p.day);
  return {
    ...p,
    epochMs,
    millisecond: ((Math.round(epochMs) % SEC_MS) + SEC_MS) % SEC_MS,
    timeZone: name,
    offsetMinutes: zoneOffsetMinutes(name, epochMs, locale),
    weekday: new Date(calendar).getUTCDay(),
    dayOfYear: Math.floor((calendar - jan1) / DAY_MS) + 1,
    daysInYear,
    isoYear: iso.year,
    isoWeek: iso.week,
    isoWeekday: iso.weekday,
    abbrev: zoneAbbrev(name, epochMs, locale),
    dst: isDstActive(name, epochMs, locale),
  };
}

export function formatInZone(timeZone: string, at: number | Date, locale: MsgLocale = 'zh-CN'): string {
  const p = zonedParts(timeZone, at, locale);
  return `${pad(p.year, 4)}-${pad(p.month, 2)}-${pad(p.day, 2)} ${pad(p.hour, 2)}:${pad(p.minute, 2)}:${pad(p.second, 2)}`;
}

export function formatZoneStamp(timeZone: string, at: number | Date, locale: MsgLocale = 'zh-CN'): string {
  const p = zonedParts(timeZone, at, locale);
  return `${formatInZone(p.timeZone, p.epochMs, locale)} (UTC${offsetLabel(p.offsetMinutes)})`;
}

export function isoInZone(timeZone: string, at: number | Date, withSeconds = true, locale: MsgLocale = 'zh-CN'): string {
  const p = zonedParts(timeZone, at, locale);
  const date = `${pad(p.year, 4)}-${pad(p.month, 2)}-${pad(p.day, 2)}`;
  const time = withSeconds
    ? `${pad(p.hour, 2)}:${pad(p.minute, 2)}:${pad(p.second, 2)}`
    : `${pad(p.hour, 2)}:${pad(p.minute, 2)}`;
  return `${date}T${time}${offsetLabel(p.offsetMinutes)}`;
}

export function chineseDate(at: number | Date, timeZone: string): string {
  const p = zonedParts(timeZone, at);
  return `${p.year}年${p.month}月${p.day}日 ${pad(p.hour, 2)}:${pad(p.minute, 2)}:${pad(p.second, 2)}`;
}

export function fractionalSeconds(epochNs: bigint): string {
  const secNs = ((epochNs % 1_000_000_000n) + 1_000_000_000n) % 1_000_000_000n;
  return String(secNs).padStart(9, '0').replace(/0+$/, '');
}

export function preciseIso(timeZone: string, instant: PreciseInstant, locale: MsgLocale = 'zh-CN'): string {
  const fraction = fractionalSeconds(instant.epochNs);
  const wholeSec = instant.epochMs - (((instant.epochMs % SEC_MS) + SEC_MS) % SEC_MS);
  const base = isoInZone(timeZone, wholeSec, true, locale);
  return fraction ? `${base.slice(0, 19)}.${fraction}${base.slice(19)}` : base;
}

export function rfc2822(at: number | Date, timeZone: string, locale: MsgLocale = 'zh-CN'): string {
  const p = zonedParts(timeZone, at, locale);
  return `${WEEKDAYS_EN_SHORT[p.weekday]}, ${pad(p.day, 2)} ${MONTHS_EN_SHORT[p.month - 1]} ${pad(p.year, 4)} ${pad(
    p.hour,
    2,
  )}:${pad(p.minute, 2)}:${pad(p.second, 2)} ${p.offsetMinutes === 0 ? 'GMT' : offsetLabel(p.offsetMinutes, false)}`;
}

export function isoWeekOf(year: number, month: number, day: number): { year: number; week: number; weekday: number } {
  const midday = Date.UTC(year, month - 1, day);
  const weekday = ((new Date(midday).getUTCDay() + 6) % 7) + 1;
  const thursday = midday + (4 - weekday) * DAY_MS;
  const isoYear = new Date(thursday).getUTCFullYear();
  const firstJan = Date.UTC(isoYear, 0, 1);
  return { year: isoYear, week: Math.floor((thursday - firstJan) / WEEK_MS) + 1, weekday };
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/* ── period bounds (epochconverter-style day / week / month / year anchors) ─ */

export type PeriodUnit = 'day' | 'week' | 'month' | 'quarter' | 'year';

export const WEEK_START_ISO_WEEKDAY = 1;

const PERIOD_SHIFT: Record<PeriodUnit, { years?: number; months?: number; weeks?: number; days?: number }> = {
  day: { days: 1 },
  week: { weeks: 1 },
  month: { months: 1 },
  quarter: { months: 3 },
  year: { years: 1 },
};

export function periodStartMs(
  timeZone: string,
  at: number | Date,
  unit: PeriodUnit,
  locale: MsgLocale = 'zh-CN',
): number {
  const name = assertTimeZone(timeZone, 'timezone', locale);
  const epochMs = clampEpoch(at instanceof Date ? at.getTime() : at);
  const p = readParts(name, epochMs, locale);
  if (unit === 'week') {
    const monday = new Date(
      Date.UTC(p.year, p.month - 1, p.day) - (isoWeekOf(p.year, p.month, p.day).weekday - WEEK_START_ISO_WEEKDAY) * DAY_MS,
    );
    return resolveWallTime(
      name,
      {
        year: monday.getUTCFullYear(),
        month: monday.getUTCMonth() + 1,
        day: monday.getUTCDate(),
        hour: 0,
        minute: 0,
        second: 0,
      },
      locale,
    ).epochMs;
  }
  const month =
    unit === 'year' ? 1 : unit === 'quarter' ? Math.floor((p.month - 1) / 3) * 3 + 1 : p.month;
  return resolveWallTime(
    name,
    { year: p.year, month, day: unit === 'day' ? p.day : 1, hour: 0, minute: 0, second: 0 },
    locale,
  ).epochMs;
}

export function periodEndMs(
  timeZone: string,
  at: number | Date,
  unit: PeriodUnit,
  locale: MsgLocale = 'zh-CN',
): number {
  const name = assertTimeZone(timeZone, 'timezone', locale);
  const start = periodStartMs(name, at, unit, locale);
  const next = shiftCalendar(start, name, PERIOD_SHIFT[unit], locale).epochMs;
  return next - SEC_MS;
}

/* ── calendar-day arithmetic shared by workdays / date-diff / date-math ───── */

export function dayIndexOf(year: number, month: number, day: number): number {
  return Math.round(Date.UTC(year, month - 1, day) / DAY_MS);
}

export function dayIndexOfInstant(timeZone: string, at: number | Date, locale: MsgLocale = 'zh-CN'): number {
  const name = assertTimeZone(timeZone, 'timezone', locale);
  const epochMs = clampEpoch(at instanceof Date ? at.getTime() : at);
  const p = readParts(name, epochMs, locale);
  return dayIndexOf(p.year, p.month, p.day);
}

export interface DayCell {
  index: number;
  year: number;
  month: number;
  day: number;
  weekday: number;
  key: string;
}

export function dayCell(index: number): DayCell {
  const date = new Date(index * DAY_MS);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  return { index, year, month, day, weekday: date.getUTCDay(), key: `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}` };
}

export const DAY_TALLY_CAP = 40000;

export interface DayTally {
  total: number;
  workdays: number;
  weekendDays: number;
  holidayDays: number;
  restDays: number;
  holidayList: string[];
  restList: DayCell[];
  truncated: boolean;
}

export function tallyDayRange(
  startIndex: number,
  dayCount: number,
  weekend: Set<number>,
  holidays: Map<string, string>,
): DayTally {
  const total = Math.max(0, Math.trunc(dayCount));
  const scan = Math.min(total, DAY_TALLY_CAP);
  let weekendDays = 0;
  let holidayDays = 0;
  const holidayList: string[] = [];
  const restList: DayCell[] = [];
  for (let offset = 0; offset < scan; offset += 1) {
    const cell = dayCell(startIndex + offset);
    const off = weekend.has(cell.weekday);
    const holiday = holidays.get(cell.key);
    if (off) weekendDays += 1;
    if (!off && holiday !== undefined) {
      holidayDays += 1;
      if (holidayList.length < 8) holidayList.push(`${cell.key}${holiday === cell.key ? '' : ` (${holiday})`}`);
    }
    if ((off || holiday !== undefined) && restList.length < 8) restList.push(cell);
  }
  const restDays = weekendDays + holidayDays;
  return {
    total: scan,
    workdays: scan - restDays,
    weekendDays,
    holidayDays,
    restDays,
    holidayList,
    restList,
    truncated: total > scan,
  };
}

export type MsgFn = (key: string, params?: Record<string, string | number>) => string;

export function parseWeekendSet(raw: string, msg: MsgFn): Set<number> {
  const set = new Set<number>();
  for (const piece of (raw ?? '').split(/[,，、;；\s]+/)) {
    const token = piece.trim();
    if (!token) continue;
    if (!/^[0-6]$/.test(token)) {
      throw new EngineError('bad_request', msg('extra.workdays.errorWeekend', { raw, token }));
    }
    set.add(Number(token));
  }
  return set;
}

export function parseHolidayMap(
  raw: string,
  timeZone: string,
  now: number,
  locale: MsgLocale = 'zh-CN',
): Map<string, string> {
  const msg = makeMsg(locale);
  const map = new Map<string, string>();
  splitLines(raw).forEach((line, position) => {
    const field = msg('extra.workdays.holidayField', { row: position + 1 });
    let instant: PreciseInstant;
    try {
      instant = parseFlexPrecise(line, { timeZone, field, fallbackNow: now }, locale);
    } catch (error) {
      if (error instanceof EngineError) {
        throw new EngineError('bad_request', msg('extra.workdays.errorHoliday', { message: error.message }));
      }
      throw error;
    }
    const parts = zonedParts(timeZone, instant.epochMs, locale);
    map.set(`${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)}`, instant.raw);
  });
  return map;
}

export function rollToWorkingDay(
  startIndex: number,
  weekend: Set<number>,
  holidays: Map<string, string>,
  direction: 1 | -1 = 1,
  limit = 28,
): { index: number; skipped: DayCell[] } {
  let cursor = startIndex;
  const skipped: DayCell[] = [];
  if (!weekend.size && !holidays.size) return { index: cursor, skipped };
  for (let step = 0; step <= limit; step += 1) {
    const cell = dayCell(cursor);
    if (!weekend.has(cell.weekday) && !holidays.has(cell.key)) return { index: cursor, skipped };
    skipped.push(cell);
    cursor += direction;
  }
  return { index: startIndex, skipped: [] };
}

export function isRestDay(cell: DayCell, weekend: Set<number>, holidays: Map<string, string>): boolean {
  return weekend.has(cell.weekday) || holidays.has(cell.key);
}

/* ── derived-value formatting ─────────────────────────────────────────────── */

const numberFormatters = new Map<string, Intl.NumberFormat>();

export function resolutionDiffers(raw: string, resolved: string): boolean {
  const given = raw.trim();
  if (!given) return false;
  return given !== resolved.replace(/\s*\((?:UTC|GMT)[^)]*\)\s*$/, '').trim();
}

export function formatNumber(value: number, locale: LocaleCode = 'zh-CN'): string {
  const tag: LocaleCode = locale === 'en-US' ? 'en-US' : 'zh-CN';
  let made = numberFormatters.get(tag);
  if (!made) {
    made = new Intl.NumberFormat(tag, { maximumFractionDigits: 2 });
    numberFormatters.set(tag, made);
  }
  if (!Number.isFinite(value)) return made.format(0);
  if (value > -0.005 && value < 0.005) return made.format(0);
  return made.format(value);
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function resolveWallTime(timeZone: string, wall: WallTime, locale: MsgLocale = 'zh-CN'): { epochMs: number; adjusted: boolean } {
  const name = assertTimeZone(timeZone, 'timezone', locale);
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  const ms = Number.isFinite(wall.millisecond) ? Math.abs(Math.trunc(wall.millisecond as number)) % SEC_MS : 0;
  let guess = naive - zoneOffsetMinutes(name, naive, locale) * MIN_MS;
  guess = naive - zoneOffsetMinutes(name, guess, locale) * MIN_MS;
  const epochMs = guess + ms;
  const back = readParts(name, epochMs, locale);
  const same =
    back.year === wall.year &&
    back.month === wall.month &&
    back.day === wall.day &&
    back.hour === wall.hour &&
    back.minute === wall.minute &&
    back.second === wall.second;
  return { epochMs, adjusted: !same };
}

export function shiftCalendar(
  epochMs: number,
  timeZone: string,
  delta: { years?: number; months?: number; weeks?: number; days?: number; hours?: number; minutes?: number; seconds?: number },
  locale: MsgLocale = 'zh-CN',
): ShiftResult {
  const name = assertTimeZone(timeZone, 'timezone', locale);
  const p = zonedParts(name, epochMs, locale);
  const months = Math.trunc((delta.years ?? 0) * 12 + (delta.months ?? 0));
  const targetIndex = (p.year * 12 + (p.month - 1) + months);
  const targetYear = Math.floor(targetIndex / 12);
  const targetMonth = (targetIndex % 12) + 1;
  const last = daysInMonth(targetYear, targetMonth);
  const targetDay = Math.min(p.day, last);
  const clamped = targetDay !== p.day && months !== 0;
  const whole = resolveWallTime(name, {
    year: targetYear,
    month: targetMonth,
    day: targetDay,
    hour: p.hour,
    minute: p.minute,
    second: p.second,
    millisecond: p.millisecond,
  }, locale);
  const calendarDays = Math.trunc((delta.weeks ?? 0) * 7 + (delta.days ?? 0));
  const shifted = whole.epochMs + calendarDays * DAY_MS;
  const reanchored = resolveWallTime(name, { ...readPartsOf(name, shifted, locale), millisecond: zonedParts(name, shifted, locale).millisecond }, locale);
  const clock =
    Math.trunc(delta.hours ?? 0) * HOUR_MS + Math.trunc(delta.minutes ?? 0) * MIN_MS + Math.trunc(delta.seconds ?? 0) * SEC_MS;
  return {
    epochMs: reanchored.epochMs + clock,
    clamped,
    clampedFrom: p.day,
    clampedTo: targetDay,
    adjusted: whole.adjusted || reanchored.adjusted,
  };
}

function readPartsOf(timeZone: string, epochMs: number, locale: MsgLocale): TimeParts {
  return readParts(timeZone, epochMs, locale);
}

export function calendarBreakdown(fromMs: number, toMs: number, timeZone: string, locale: MsgLocale = 'zh-CN'): CalendarSpan {
  const name = assertTimeZone(timeZone, 'timezone', locale);
  const sign: 1 | -1 | 0 = toMs > fromMs ? 1 : toMs < fromMs ? -1 : 0;
  let start = Math.min(fromMs, toMs);
  const end = Math.max(fromMs, toMs);
  const span: CalendarSpan = { sign, years: 0, months: 0, weeks: 0, days: 0, hours: 0, minutes: 0, seconds: 0, milliseconds: 0 };
  const step = (field: 'years' | 'months', factor: number, unit: 'years' | 'months') => {
    for (;;) {
      const next = shiftCalendar(start, name, { [field]: factor }, locale).epochMs;
      if (next > end || next <= start) break;
      start = next;
      span[unit] += 1;
    }
  };
  step('years', 1, 'years');
  step('months', 1, 'months');
  const rem = end - start;
  span.days = Math.floor(rem / DAY_MS);
  let rest = rem - span.days * DAY_MS;
  span.hours = Math.floor(rest / HOUR_MS);
  rest -= span.hours * HOUR_MS;
  span.minutes = Math.floor(rest / MIN_MS);
  rest -= span.minutes * MIN_MS;
  span.seconds = Math.floor(rest / SEC_MS);
  span.milliseconds = rest - span.seconds * SEC_MS;
  span.weeks = Math.floor(span.days / 7);
  span.days %= 7;
  return span;
}

/* ── flexible parsing ─────────────────────────────────────────────────────── */

const NUMERIC = /^([+-]?)(\d+)(?:\.(\d+))?$/;
const WALL_SOURCE =
  '(\\d{4})[-/](\\d{1,2})[-/](\\d{1,2})(?:[T,\\s]+(\\d{1,2}):(\\d{2})(?::(\\d{2}))?(?:[.,](\\d{1,9}))?\\s*(Z|z|[+-]\\d{2}:?\\d{2})?)?';
const WALL = new RegExp(`^${WALL_SOURCE}$`);
const WALL_PREFIX = new RegExp(`^${WALL_SOURCE}`);
const ISO_OFFSET_MINUTES = /^([+-])(\d{2}):?(\d{2})$/;

function bad(field: string, raw: string, locale: MsgLocale, reason = ''): EngineError {
  const t = makeMsg(locale);
  return new EngineError(
    'bad_request',
    t(reason ? 'core.error.parseWithReason' : 'core.error.parse', {
      field,
      raw,
      reason,
      examples: t('core.parse.examples'),
    }),
  );
}

export function clampEpoch(epochMs: number): number {
  if (!Number.isFinite(epochMs)) return 0;
  return Math.min(MAX_EPOCH_MS, Math.max(-MAX_EPOCH_MS, epochMs));
}

function checkRange(raw: string, field: string, epochMs: number, epochNs: bigint, locale: MsgLocale): void {
  const t = makeMsg(locale);
  if (Number.isNaN(epochMs)) throw bad(field, raw, locale, t('core.reason.notANumber'));
  if (epochMs > MAX_EPOCH_MS || epochMs < -MAX_EPOCH_MS) throw bad(field, raw, locale, t('core.reason.outOfRange'));
  void epochNs;
}

function autoUnit(digits: string): FlexUnit {
  const len = digits.replace(/^0+/, '').length || 1;
  if (len <= 10) return 's';
  if (len <= 13) return 'ms';
  if (len <= 16) return 'us';
  return 'ns';
}

function fromDigits(raw: string, field: string, unitOption: InputUnit, locale: MsgLocale): PreciseInstant {
  const match = NUMERIC.exec(raw);
  if (!match) throw bad(field, raw, locale);
  const sign = match[1] === '-' ? '-' : '';
  const intDigits = match[2] ?? '0';
  const fracDigits = match[3] ?? '';
  const unit: FlexUnit = unitOption === 'auto' ? autoUnit(intDigits) : unitOption;
  const numerator = BigInt(`${sign}${intDigits}${fracDigits}`);
  const shift = unitExponent(unit) - fracDigits.length;
  const power = 10n ** BigInt(Math.abs(shift));
  // Nanoseconds stay in BigInt so 19-digit inputs never round through a float.
  const epochNs = shift >= 0 ? numerator * power : divRound(numerator, power);
  const epochMs = Number(divRound(epochNs, 1_000_000n));
  checkRange(raw, field, epochMs, epochNs, locale);
  return {
    date: new Date(clampEpoch(epochMs)),
    epochMs: clampEpoch(epochMs),
    epochUs: epochNs / 1_000n,
    epochNs,
    unit,
    sourceUnit: unitOption,
    raw,
    exact: epochNs !== BigInt(epochMs) * 1_000_000n,
  };
}

function unitExponent(unit: FlexUnit): number {
  return unit === 's' ? 9 : unit === 'ms' ? 6 : unit === 'us' ? 3 : 0;
}

function divRound(value: bigint, divisor: bigint): bigint {
  const quotient = value / divisor;
  const remainder = value % divisor;
  if (remainder === 0n) return quotient;
  const magnitude = remainder < 0n ? -remainder : remainder;
  const adjusted = magnitude * 2n >= divisor ? 1n : 0n;
  return value >= 0n ? quotient + adjusted : quotient - adjusted;
}

export function parseFlexPrecise(
  input: string | number,
  options: FlexOptions = {},
  locale: MsgLocale = 'zh-CN',
): PreciseInstant {
  const t = makeMsg(locale);
  const raw = typeof input === 'number' ? String(input) : (input ?? '').trim();
  const field = options.field ?? 'input';
  if (!raw) throw bad(field, raw, locale, t('core.reason.empty'));
  const name = assertTimeZone(options.timeZone ?? 'UTC', 'timezone', locale);
  const now = Number.isFinite(options.fallbackNow) ? (options.fallbackNow as number) : Date.now();
  const phraseMs = phraseEpochMs(raw, name, now, field, locale);
  if (phraseMs !== null) {
    const ms = Math.round(phraseMs);
    checkRange(raw, field, ms, BigInt(ms) * 1_000_000n, locale);
    return finalize(ms, BigInt(ms) * 1_000_000n, 'text', options, raw);
  }
  if (NUMERIC.test(raw)) return fromDigits(raw, field, options.unit ?? 'auto', locale);
  const match = WALL.exec(raw.replace(/\s{2,}/g, ' '));
  if (!match) {
    const alt = altGrammarEpochMs(raw, name, field, locale);
    if (!alt) throw bad(field, raw, locale);
    const altNs = BigInt(alt.epochMs) * 1_000_000n + alt.subNs;
    checkRange(raw, field, alt.epochMs, altNs, locale);
    return finalize(alt.epochMs, altNs, 'text', options, raw);
  }
  const [, ys, mos, ds, hs = '0', mns = '0', ss = '0', frac, zoneTag] = match;
  const year = Number(ys);
  const month = Number(mos);
  const day = Number(ds);
  const hour = Number(hs);
  const minute = Number(mns);
  const second = Number(ss);
  if (year < 1 || year > 9999) throw bad(field, raw, locale, t('core.reason.yearRange'));
  if (month < 1 || month > 12) throw bad(field, raw, locale, t('core.reason.monthRange'));
  if (day < 1 || day > daysInMonth(year, month))
    throw bad(field, raw, locale, t('core.reason.dayOverflow', { year, month, days: daysInMonth(year, month) }));
  if (hour > 23 || minute > 59 || second > 59) throw bad(field, raw, locale, t('core.reason.clockRange'));
  const subNs = BigInt((frac ?? '').padEnd(9, '0').slice(0, 9) || '0');
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  let epochMs: number;
  if (zoneTag) {
    const zoneMinutes =
      zoneTag === 'Z' || zoneTag === 'z' ? 0 : zoneOffsetFromTag(zoneTag, raw, field, locale);
    epochMs = naive - zoneMinutes * MIN_MS;
  } else {
    epochMs = resolveWallTime(name, { year, month, day, hour, minute, second }, locale).epochMs;
  }
  checkRange(raw, field, epochMs, BigInt(epochMs) * 1_000_000n, locale);
  return finalize(epochMs, BigInt(epochMs) * 1_000_000n + subNs, 'text', options, raw);
}

function zoneOffsetFromTag(tag: string, raw: string, field: string, locale: MsgLocale): number {
  const t = makeMsg(locale);
  const match = ISO_OFFSET_MINUTES.exec(tag);
  if (!match) throw bad(field, raw, locale, t('core.reason.utcOffsetFormat'));
  const hh = Number(match[2]);
  const mm = Number(match[3]);
  if (hh > 23 || mm > 59) throw bad(field, raw, locale, t('core.reason.utcOffsetRange'));
  return (match[1] === '-' ? -1 : 1) * (hh * 60 + mm);
}

function finalize(
  epochMs: number,
  epochNs: bigint,
  unit: FlexUnit | 'text',
  options: FlexOptions,
  raw: string,
): PreciseInstant {
  const ms = Math.round(epochMs);
  return {
    date: new Date(clampEpoch(ms)),
    epochMs: clampEpoch(ms),
    epochUs: epochNs / 1_000n,
    epochNs,
    unit,
    sourceUnit: options.unit ?? 'auto',
    raw,
    exact: epochNs !== BigInt(ms) * 1_000_000n,
  };
}

type PhraseBase =
  | { kind: 'now' }
  | { kind: 'day'; days: number }
  | { kind: 'start'; unit: 'week' | 'month' | 'quarter' | 'year' };

interface PhraseDelta {
  years: number;
  months: number;
  weeks: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

const PHRASE_BASES = new Map<string, PhraseBase>([
  ['now', { kind: 'now' }],
  ['现在', { kind: 'now' }],
  ['today', { kind: 'day', days: 0 }],
  ['今天', { kind: 'day', days: 0 }],
  ['yesterday', { kind: 'day', days: -1 }],
  ['昨天', { kind: 'day', days: -1 }],
  ['前天', { kind: 'day', days: -2 }],
  ['tomorrow', { kind: 'day', days: 1 }],
  ['明天', { kind: 'day', days: 1 }],
  ['后天', { kind: 'day', days: 2 }],
  ['week-start', { kind: 'start', unit: 'week' }],
  ['month-start', { kind: 'start', unit: 'month' }],
  ['quarter-start', { kind: 'start', unit: 'quarter' }],
  ['year-start', { kind: 'start', unit: 'year' }],
]);

const PHRASE_KEYWORD = new RegExp(
  `^(${[...PHRASE_BASES.keys()].sort((a, b) => b.length - a.length).join('|')})`,
);
const PHRASE_OFFSET = /^\s*([+-]\d{1,9})([yMwdhms])(?![0-9a-z])/;
const PHRASE_CLOCK = /^T?(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
/** Uppercase `M` means months, lowercase `m` minutes; the keywords stay case-insensitive. */
const PHRASE_UNITS: Record<string, keyof PhraseDelta> = {
  y: 'years',
  M: 'months',
  w: 'weeks',
  d: 'days',
  h: 'hours',
  m: 'minutes',
  s: 'seconds',
};

function startOfPeriod(
  timeZone: string,
  now: number,
  unit: 'week' | 'month' | 'quarter' | 'year',
  locale: MsgLocale,
): TimeParts {
  const p = readParts(timeZone, now, locale);
  if (unit === 'week') {
    const midnight = Date.UTC(p.year, p.month - 1, p.day);
    const monday = new Date(midnight - (isoWeekOf(p.year, p.month, p.day).weekday - 1) * DAY_MS);
    return {
      year: monday.getUTCFullYear(),
      month: monday.getUTCMonth() + 1,
      day: monday.getUTCDate(),
      hour: 0,
      minute: 0,
      second: 0,
    };
  }
  const month =
    unit === 'year' ? 1 : unit === 'quarter' ? Math.floor((p.month - 1) / 3) * 3 + 1 : p.month;
  return { year: p.year, month, day: 1, hour: 0, minute: 0, second: 0 };
}

/** Relative phrases such as `yesterday 14:30`, `前天`, `week-start`, `now+3d`, `2026-03-08 -1w`. */
function phraseEpochMs(
  raw: string,
  timeZone: string,
  now: number,
  field: string,
  locale: MsgLocale,
): number | null {
  const t = makeMsg(locale);
  const text = raw.trim().replace(/\s+/g, ' ');
  const lower = text.toLowerCase();
  let cursor = 0;
  let base: PhraseBase | undefined;
  let wallBase = '';

  const keyword = PHRASE_KEYWORD.exec(lower);
  if (keyword) {
    base = PHRASE_BASES.get(keyword[1] ?? '');
    cursor = keyword[0].length;
  } else {
    const wall = WALL_PREFIX.exec(text);
    if (wall && PHRASE_OFFSET.test(lower.slice(wall[0].length))) {
      wallBase = wall[0].trim();
      cursor = wall[0].length;
    } else if (!PHRASE_OFFSET.test(lower)) {
      return null;
    }
  }

  const delta: PhraseDelta = { years: 0, months: 0, weeks: 0, days: 0, hours: 0, minutes: 0, seconds: 0 };
  let shifted = false;
  for (;;) {
    const rest = text.slice(cursor);
    const hit = PHRASE_OFFSET.exec(lower.slice(cursor));
    if (!hit) break;
    const unit = PHRASE_UNITS[rest[hit[0].length - 1] ?? ''];
    const amount = Number(hit[1]);
    if (!unit || !Number.isFinite(amount)) return null;
    delta[unit] += amount;
    shifted = true;
    cursor += hit[0].length;
  }

  const tail = text.slice(cursor).trim();
  let clock: { hour: number; minute: number; second: number } | null = null;
  if (tail) {
    const tm = PHRASE_CLOCK.exec(tail);
    if (!tm) return null;
    clock = { hour: Number(tm[1]), minute: Number(tm[2]), second: Number(tm[3] ?? 0) };
    if (clock.hour > 23 || clock.minute > 59 || clock.second > 59) {
      throw bad(field, raw, locale, t('core.reason.clockRange'));
    }
  }
  if (!base && !wallBase && !shifted) return null;

  let epochMs: number;
  if (wallBase) {
    epochMs = parseFlexPrecise(wallBase, { timeZone, field }, locale).epochMs;
    if (clock) epochMs = resolveWallTime(timeZone, { ...readParts(timeZone, epochMs, locale), ...clock }, locale).epochMs;
  } else if (!base || base.kind === 'now') {
    epochMs = Math.round(now);
    if (clock) epochMs = resolveWallTime(timeZone, { ...readParts(timeZone, epochMs, locale), ...clock }, locale).epochMs;
  } else {
    const parts =
      base.kind === 'day'
        ? readParts(timeZone, Math.round(now) + base.days * DAY_MS, locale)
        : startOfPeriod(timeZone, now, base.unit, locale);
    epochMs = resolveWallTime(timeZone, { ...parts, ...(clock ?? { hour: 0, minute: 0, second: 0 }) }, locale).epochMs;
  }
  if (shifted) epochMs = shiftCalendar(epochMs, timeZone, delta, locale).epochMs;
  return epochMs;
}

export function parseFlex(input: string | number, options: FlexOptions = {}, locale: MsgLocale = 'zh-CN'): Date {
  return parseFlexPrecise(input, options, locale).date;
}

/* ── extra grammars: RFC 2822 / HTTP-date, textual months, M-D-Y and D-M-Y ── */

const MONTHS_EN_FULL = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const MONTH_ALIASES = new Map<string, number>();
MONTHS_EN_SHORT.forEach((name, index) => MONTH_ALIASES.set(name.toLowerCase(), index + 1));
MONTHS_EN_FULL.forEach((name, index) => MONTH_ALIASES.set(name.toLowerCase(), index + 1));

const WEEKDAY_ALIASES = new Set<string>([
  ...WEEKDAYS_EN.map((name) => name.toLowerCase()),
  ...WEEKDAYS_EN_SHORT.map((name) => name.toLowerCase()),
]);

const ALT_CLOCK =
  /(?<hour>\d{1,2}):(?<minute>\d{2})(?::(?<second>\d{2}))?(?:[.,](?<frac>\d{1,9}))?(?:\s*(?<meridian>[AaPp]\.?[Mm]\.?))?\s*(?<zone>Z|z|[+-]\d{2}:?\d{2}|[A-Za-z]{2,4})?$/;
const ALT_DAY_MONTH_NAME = /^(?<day>\d{1,2})[\s.-]+(?<month>[A-Za-z]{3,9})\.?[\s.,-]+(?<year>\d{2,4})\.?$/;
const ALT_MONTH_NAME_DAY = /^(?<month>[A-Za-z]{3,9})\.?[\s.-]+(?<day>\d{1,2})(?:st|nd|rd|th)?[.,\s-]+(?<year>\d{2,4})\.?$/;
const ALT_NUMERIC = /^(?<first>\d{1,2})(?<sep>[/\-.])(?<second>\d{1,2})\k<sep>(?<year>\d{4})$/;
const ALT_WEEKDAY_PREFIX = /^(?<name>[A-Za-z]{3,9})\.?\s*,?\s+/;
const ALT_ZONE_OFFSET = /^(?<sign>[+-])(?<hh>\d{2}):?(?<mm>\d{2})$/;

const ALT_NAMED_ZONES: Record<string, number> = {
  z: 0,
  ut: 0,
  utc: 0,
  gmt: 0,
  est: -300,
  edt: -240,
  cst: -360,
  cdt: -300,
  mst: -420,
  mdt: -360,
  pst: -480,
  pdt: -420,
  ast: -240,
  adt: -180,
  nst: -210,
  ndt: -150,
  cet: 60,
  cest: 120,
  eet: 120,
  eest: 180,
  bst: 60,
  msk: 180,
  jst: 540,
  kst: 540,
  aest: 600,
  aedt: 660,
};

function expandYear(text: string): number {
  const digits = Number(text);
  if (text.length >= 3) return digits;
  return digits <= 68 ? 2000 + digits : 1900 + digits;
}

function altZoneMinutes(tag: string): number | null {
  if (!tag) return null;
  if (tag === 'Z' || tag === 'z') return 0;
  const numeric = ALT_ZONE_OFFSET.exec(tag);
  if (numeric) {
    const hh = Number(numeric[2]);
    const mm = Number(numeric[3]);
    if (hh > 23 || mm > 59) return null;
    return (numeric[1] === '-' ? -1 : 1) * (hh * 60 + mm);
  }
  const named = ALT_NAMED_ZONES[tag.toLowerCase()];
  return named === undefined ? null : named;
}

function altDateParts(text: string): { year: number; month: number; day: number } | null {
  const dayNamed = ALT_DAY_MONTH_NAME.exec(text);
  if (dayNamed) {
    const month = MONTH_ALIASES.get((dayNamed.groups?.month ?? '').toLowerCase());
    if (!month) return null;
    return { year: expandYear(dayNamed.groups?.year ?? ''), month, day: Number(dayNamed.groups?.day) };
  }
  const monthNamed = ALT_MONTH_NAME_DAY.exec(text);
  if (monthNamed) {
    const month = MONTH_ALIASES.get((monthNamed.groups?.month ?? '').toLowerCase());
    if (!month) return null;
    return { year: expandYear(monthNamed.groups?.year ?? ''), month, day: Number(monthNamed.groups?.day) };
  }
  const numeric = ALT_NUMERIC.exec(text);
  if (!numeric) return null;
  const groups = numeric.groups ?? {};
  const first = Number(groups.first);
  const second = Number(groups.second);
  const year = expandYear(groups.year ?? '');
  const readings: Array<[number, number]> =
    groups.sep === '/'
      ? [
          [first, second],
          [second, first],
        ]
      : [
          [second, first],
          [first, second],
        ];
  for (const [month, day] of readings) {
    if (month < 1 || month > 12) continue;
    if (day < 1 || day > daysInMonth(year, month)) continue;
    return { year, month, day };
  }
  return null;
}

/** Returns null when the input matches none of the extra grammars; the caller then raises the generic parse error. */
function altGrammarEpochMs(
  raw: string,
  timeZone: string,
  field: string,
  locale: MsgLocale,
): { epochMs: number; subNs: bigint } | null {
  const t = makeMsg(locale);
  const text = raw.trim().replace(/\s{2,}/g, ' ');
  const clock = ALT_CLOCK.exec(text);
  let hour = 0;
  let minute = 0;
  let second = 0;
  let subNs = 0n;
  let zoneMinutes: number | null = null;
  let dateText = text;

  if (clock) {
    const groups = clock.groups ?? {};
    dateText = text.slice(0, clock.index).trim().replace(/[,.\s-]+$/, '');
    hour = Number(groups.hour);
    minute = Number(groups.minute);
    second = Number(groups.second ?? '0');
    const meridian = (groups.meridian ?? '').replace(/\./g, '').toUpperCase();
    if (meridian.startsWith('P') && hour < 12) hour += 12;
    if (meridian.startsWith('A') && hour === 12) hour = 0;
    subNs = BigInt((groups.frac ?? '').padEnd(9, '0').slice(0, 9) || '0');
    const zoneTag = (groups.zone ?? '').trim();
    if (zoneTag) {
      zoneMinutes = altZoneMinutes(zoneTag);
      if (zoneMinutes === null) return null;
    }
  }

  const weekdayPrefix = ALT_WEEKDAY_PREFIX.exec(dateText);
  if (weekdayPrefix && WEEKDAY_ALIASES.has((weekdayPrefix.groups?.name ?? '').toLowerCase())) {
    dateText = dateText.slice(weekdayPrefix[0].length);
  }
  const parts = altDateParts(dateText.trim());
  if (!parts) return null;
  const { year, month, day } = parts;

  if (year < 1 || year > 9999) throw bad(field, raw, locale, t('core.reason.yearRange'));
  if (month < 1 || month > 12) throw bad(field, raw, locale, t('core.reason.monthRange'));
  if (day < 1 || day > daysInMonth(year, month)) {
    throw bad(field, raw, locale, t('core.reason.dayOverflow', { year, month, days: daysInMonth(year, month) }));
  }
  if (hour > 23 || minute > 59 || second > 59) throw bad(field, raw, locale, t('core.reason.clockRange'));

  const epochMs =
    zoneMinutes === null
      ? resolveWallTime(timeZone, { year, month, day, hour, minute, second }, locale).epochMs
      : Date.UTC(year, month - 1, day, hour, minute, second) - zoneMinutes * MIN_MS;
  return { epochMs, subNs };
}

export function splitLines(text: string): string[] {
  return (text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/* ── relative phrasing ────────────────────────────────────────────────────── */

const RELATIVE_STEPS: Array<{ unit: Intl.RelativeTimeFormatUnit; ms: number }> = [
  { unit: 'second', ms: SEC_MS },
  { unit: 'minute', ms: MIN_MS },
  { unit: 'hour', ms: HOUR_MS },
  { unit: 'day', ms: DAY_MS },
  { unit: 'week', ms: WEEK_MS },
  { unit: 'month', ms: MONTH_MS },
  { unit: 'year', ms: YEAR_MS },
];

export function dominantSpan(deltaMs: number): { value: number; unit: Intl.RelativeTimeFormatUnit } {
  const abs = Math.abs(deltaMs);
  let index = RELATIVE_STEPS.length - 1;
  for (let i = 0; i < RELATIVE_STEPS.length - 1; i += 1) {
    const next = RELATIVE_STEPS[i + 1];
    if (!next || abs < next.ms) {
      index = i;
      break;
    }
  }
  const step = RELATIVE_STEPS[index] ?? { unit: 'year' as const, ms: YEAR_MS };
  // Calendar units truncate so "2 年 10 个月" never reads as "3 年前".
  const amount = step.ms >= DAY_MS ? Math.trunc(deltaMs / step.ms) : Math.round(deltaMs / step.ms);
  return { value: amount, unit: step.unit };
}

export function phraseLocale(uiLocale: MsgLocale, locale: LocaleCode): LocaleCode {
  return uiLocale === 'en' ? 'en-US' : locale;
}

const UNIT_MSG_KEYS: Record<string, string> = {
  s: 'common.unit.second',
  second: 'common.unit.second',
  seconds: 'common.unit.second',
  min: 'common.unit.minute',
  minute: 'common.unit.minute',
  minutes: 'common.unit.minute',
  h: 'common.unit.hour',
  hour: 'common.unit.hour',
  hours: 'common.unit.hour',
  d: 'common.unit.day',
  day: 'common.unit.day',
  days: 'common.unit.day',
  w: 'common.unit.week',
  week: 'common.unit.week',
  weeks: 'common.unit.week',
};

export function unitMsgKey(unit: string): string {
  return UNIT_MSG_KEYS[unit] ?? `time.unit.${unit}`;
}

export function relativePhrase(deltaMs: number, locale: LocaleCode, numeric: 'auto' | 'always' = 'always'): string {
  const { value, unit } = dominantSpan(deltaMs);
  const amount = value === 0 ? (deltaMs === 0 ? 0 : signOf(deltaMs)) : value;
  try {
    return new Intl.RelativeTimeFormat(locale, { numeric, style: 'long' }).format(amount, unit);
  } catch {
    const zh = ZH_UNITS[unit as keyof typeof ZH_UNITS] ?? unit;
    return amount < 0 ? `${Math.abs(amount)}${zh}前` : `${amount}${zh}后`;
  }
}

const ZH_UNITS = { second: '秒', minute: '分钟', hour: '小时', day: '天', week: '周', month: '个月', year: '年' } as const;

function signOf(deltaMs: number): number {
  return deltaMs < 0 ? -1 : 1;
}

export function spanText(span: CalendarSpan, locale: LocaleCode = 'zh-CN'): string {
  const abs = Math.abs;
  const pieces: string[] = [];
  const push = (value: number, unit: string) => {
    if (abs(value) > 0) pieces.push(`${abs(value)}${unit}`);
  };
  if (locale === 'en-US') {
    push(span.years, 'y');
    push(span.months, 'mo');
    push(span.weeks, 'w');
    push(span.days, 'd');
    push(span.hours, 'h');
    push(span.minutes, 'm');
    push(span.seconds, 's');
    push(span.milliseconds, 'ms');
  } else {
    push(span.years, '年');
    push(span.months, '个月');
    push(span.weeks, '周');
    push(span.days, '天');
    push(span.hours, '小时');
    push(span.minutes, '分钟');
    push(span.seconds, '秒');
    push(span.milliseconds, '毫秒');
  }
  const text = pieces.join(' ') || (locale === 'en-US' ? '0s' : '0秒');
  return span.sign < 0 ? `-${text}` : text;
}

export function ordinalTotal(ms: number, unit: string, locale: LocaleCode = 'zh-CN'): string {
  const table: Record<string, [number, string, string]> = {
    ms: [SEC_MS, '毫秒', 'ms'],
    seconds: [SEC_MS, '秒', 's'],
    minutes: [MIN_MS, '分钟', 'min'],
    hours: [HOUR_MS, '小时', 'h'],
    days: [DAY_MS, '天', 'd'],
    weeks: [WEEK_MS, '周', 'w'],
  };
  const fallback: [number, string, string] = [SEC_MS, '秒', 's'];
  const entry: [number, string, string] = table[unit] ?? fallback;
  const value = decimalTrim(ms / entry[0]);
  return `${value} ${locale === 'en-US' ? entry[2] : entry[1]}`;
}

export function decimalTrim(value: number, digits = 6): string {
  if (!Number.isFinite(value)) return '0';
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
}

/* ── text layout ──────────────────────────────────────────────────────────── */

export type Row = readonly [label: string, value: string | number];

export function pad(value: string | number, width: number, char = '0'): string {
  const text = String(value);
  return text.length >= width ? text : char.repeat(width - text.length) + text;
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    width += isWide(code) ? 2 : 1;
  }
  return width;
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  );
}

export function padTo(text: string, width: number): string {
  const gap = width - displayWidth(text);
  return gap > 0 ? text + ' '.repeat(gap) : text;
}

export function alignRows(rows: Row[], indent = 2, gap = 2): string {
  const width = rows.reduce((max, row) => Math.max(max, displayWidth(row[0])), 0);
  return rows
    .map((row) => `${' '.repeat(indent)}${padTo(row[0], width + gap)}${String(row[1])}`)
    .join('\n');
}

export function section(title: string, width = 60): string {
  const head = `── ${title} `;
  return displayWidth(head) >= width ? head.trimEnd() : head + '─'.repeat(width - displayWidth(head));
}

export function bullet(text: string, indent = 2): string {
  return `${' '.repeat(indent)}· ${text}`;
}

export function joinBlocks(blocks: Array<string | string[] | null | undefined>): string {
  return blocks
    .filter((block): block is string | string[] => block !== null && block !== undefined && (Array.isArray(block) ? block.length > 0 : block.trim().length > 0))
    .map((block) => (Array.isArray(block) ? block.join('\n') : block).replace(/\s+$/, ''))
    .join('\n\n');
}

export function emitText(ctx: ToolContext, name: string, text: string): Promise<void> {
  const body = text.replace(/\s+$/, '');
  return ctx.emit({ name, kind: 'text', bytes: new TextEncoder().encode(`${body}\n`) });
}

/* ── option access ────────────────────────────────────────────────────────── */

export function optStr(ctx: ToolContext, key: string, fallback = ''): string {
  const value = ctx.options[key];
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

export function optNum(ctx: ToolContext, key: string, fallback: number): number {
  const value = Number(ctx.options[key]);
  return Number.isFinite(value) ? value : fallback;
}

export function optBool(ctx: ToolContext, key: string, fallback: boolean): boolean {
  const value = ctx.options[key];
  if (value === undefined) return fallback;
  return value === true || value === 'true' || value === 1 || value === '1';
}

export function optSelect<T extends string>(ctx: ToolContext, key: string, allowed: readonly T[], fallback: T): T {
  const value = optStr(ctx, key) as T;
  return allowed.includes(value) ? value : fallback;
}

export function optLabel(msg: MsgFn, namespace: string, value: string): string {
  const key = `time.opt.${namespace}.${value}`;
  const label = msg(key);
  return label === key ? value : label;
}

export function optLocale(ctx: ToolContext, key = 'locale'): LocaleCode {
  const value = optStr(ctx, key, 'zh-CN').toLowerCase();
  return value.startsWith('en') ? 'en-US' : 'zh-CN';
}

export function nowOf(_ctx?: ToolContext): number {
  return Date.now();
}
