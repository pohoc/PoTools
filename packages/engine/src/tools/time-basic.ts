import { EngineError } from '../errors.ts';
import type { ToolImpl, ToolResult } from '../types.ts';
import { localeOf, makeMsg } from '../lib/messages.ts';
import {
  DAY_MS,
  DAY_TALLY_CAP,
  HOUR_MS,
  MIN_MS,
  SEC_MS,
  WEEK_MS,
  WEEKDAYS_EN,
  WEEKDAYS_EN_SHORT,
  WEEKDAYS_ZH,
  alignRows,
  assertTimeZone,
  calendarBreakdown,
  chineseDate,
  dayCell,
  dayIndexOfInstant,
  emitText,
  formatInZone,
  formatNumber,
  formatZoneStamp,
  fractionalSeconds,
  isoInZone,
  joinBlocks,
  nowOf,
  offsetLabel,
  optBool,
  optLabel,
  optLocale,
  optNum,
  optSelect,
  optStr,
  pad,
  parseFlexPrecise,
  parseHolidayMap,
  parseWeekendSet,
  periodEndMs,
  periodStartMs,
  phraseLocale,
  preciseIso,
  relativePhrase,
  resolveWallTime,
  rfc2822,
  rollToWorkingDay,
  section,
  shiftCalendar,
  spanText,
  splitLines,
  tallyDayRange,
  unitMsgKey,
  zonedParts,
  type CalendarSpan,
  type LocaleCode,
  type MsgLocale,
  type PeriodUnit,
  type PreciseInstant,
  type ZonedParts,
} from './time-core.ts';

type Msg = ReturnType<typeof makeMsg>;

const TIMESTAMP_STYLES = ['full', 'both', 'iso', 'date', 'datetime', 'relative', 'chinese'] as const;
type TimestampStyle = (typeof TIMESTAMP_STYLES)[number];

const DATE_UNITS = ['auto', 'days', 'hours', 'minutes', 'seconds', 'ms', 'weeks'] as const;
type DateUnit = (typeof DATE_UNITS)[number];

const MATH_UNITS = ['years', 'months', 'weeks', 'days', 'hours', 'minutes', 'seconds'] as const;
type MathUnit = (typeof MATH_UNITS)[number];

function unitName(unit: string, msg: Msg): string {
  return msg(unitMsgKey(unit));
}

function mathUnitLabel(unit: string, magnitude: number, uiLocale: MsgLocale, msg: Msg): string {
  const name = unitName(unit, msg);
  return uiLocale === 'en' && magnitude === 1 ? name.replace(/s$/, '') : name;
}

function enUnit(unit: string): string {
  const map: Record<string, string> = {
    ms: 'ms',
    seconds: 's',
    minutes: 'min',
    hours: 'h',
    days: 'd',
    weeks: 'w',
    us: 'µs',
    ns: 'ns',
  };
  return map[unit] ?? unit;
}

function unitSuffix(unit: string, locale: LocaleCode, msg: Msg): string {
  return locale === 'en-US' ? enUnit(unit) : unitName(unit, msg);
}

function weekdayIndex(weekday: number): number {
  return ((weekday % 7) + 7) % 7;
}

function weekdayPair(weekday: number, uiLocale: MsgLocale): string {
  const index = weekdayIndex(weekday);
  return uiLocale === 'en'
    ? `${WEEKDAYS_EN[index] ?? ''} (${WEEKDAYS_EN_SHORT[index] ?? ''})`
    : `${WEEKDAYS_ZH[index] ?? ''} (${WEEKDAYS_EN[index] ?? ''})`;
}

function weekdaySpelled(weekday: number, uiLocale: MsgLocale): string {
  const index = weekdayIndex(weekday);
  return uiLocale === 'en' ? (WEEKDAYS_EN[index] ?? '') : (WEEKDAYS_ZH[index] ?? '');
}

function longDate(at: number, timeZone: string, uiLocale: MsgLocale): string {
  if (uiLocale !== 'en') return chineseDate(at, timeZone);
  return new Intl.DateTimeFormat('en', { dateStyle: 'long', timeStyle: 'medium', timeZone }).format(new Date(at));
}

function zoneText(parts: ZonedParts, msg: Msg): string {
  return msg('time.zone.line', {
    zone: parts.timeZone,
    offset: offsetLabel(parts.offsetMinutes),
    abbrev: parts.abbrev,
    state: msg(parts.dst ? 'time.zone.dstOn' : 'time.zone.dstOff'),
  });
}

function instantText(parts: ZonedParts, msg: Msg): string {
  return msg('time.instant.line', {
    abbrev: parts.abbrev,
    state: msg(parts.dst ? 'time.instant.dstOn' : 'time.instant.dstOff'),
  });
}

function signed(value: number, locale: LocaleCode): string {
  if (!Number.isFinite(value)) return `+ ${formatNumber(0, locale)}`;
  return `${value < 0 ? '−' : '+'} ${formatNumber(Math.abs(value), locale)}`;
}

const timestampTool: ToolImpl = {
  id: 'timestamp',
  async run(ctx): Promise<ToolResult> {
    const uiLocale = localeOf(ctx);
    const msg = makeMsg(uiLocale);
    const lines = splitLines(optStr(ctx, 'input'));
    if (!lines.length) {
      throw new EngineError('bad_request', msg('basic.timestamp.error.empty'));
    }
    const timeZone = assertTimeZone(optStr(ctx, 'timezone') || 'Asia/Shanghai', 'timezone', uiLocale);
    const unit = optSelect(ctx, 'unit', ['auto', 's', 'ms', 'us', 'ns'] as const, 'auto');
    const style = optSelect(ctx, 'style', TIMESTAMP_STYLES, 'both');
    const locale = phraseLocale(uiLocale, optLocale(ctx));
    const showRange = optBool(ctx, 'showRange', true);
    const showNow = optBool(ctx, 'showNow', true);
    const now = nowOf(ctx);
    // Simple styles are intended for direct copy/paste. Do not wrap them in
    // the diagnostic report used by the full style.
    if (style !== 'full') {
      const output = lines.map((line, index) => {
        const instant = parseFlexPrecise(line, { timeZone, field: 'input', unit, fallbackNow: now }, uiLocale);
        const parts = zoned(timeZone, instant.epochMs, uiLocale);
        ctx.report({ percent: Math.min(99, Math.round(((index + 1) / lines.length) * 99)), phase: 'render' });
        return renderStyle(style, parts, instant, now, locale, uiLocale);
      }).join('\n');
      await emitText(ctx, 'timestamp.txt', output);
      ctx.report({ percent: 100, phase: 'done' });
      return { extra: { inputs: lines.length, timezone: timeZone, style, unit, showRange: 'false', showNow: 'false' } };
    }
    const blocks: string[] = [
      section(msg('basic.timestamp.title', { count: lines.length, zone: timeZone })),
      alignRows([
        [msg('basic.timestamp.unitLabel'), unit === 'auto' ? msg('basic.timestamp.autoValue') : msg('basic.timestamp.unixUnit', { unit: unitName(unit, msg) })],
        [msg('basic.timestamp.styleLabel'), optLabel(msg, 'timestamp.style', style)],
        [msg('basic.timestamp.nowLabel'), `${formatZoneStamp(timeZone, now, uiLocale)}`],
      ]),
    ];
    if (showNow) {
      blocks.push(
        section(msg('basic.timestamp.nowTitle')),
        alignRows([
          [msg('basic.timestamp.unixSec'), String(Math.floor(now / SEC_MS))],
          [msg('basic.timestamp.unixMs'), String(now)],
          [msg('time.label.localTime'), formatInZone(timeZone, now, uiLocale)],
          [msg('time.label.timezone'), zoneText(zoned(timeZone, now, uiLocale), msg)],
        ]),
      );
    }
    lines.forEach((line, index) => {
      const instant = parseFlexPrecise(line, { timeZone, field: 'input', unit, fallbackNow: now }, uiLocale);
      const parts = zoned(timeZone, instant.epochMs, uiLocale);
      const body =
        style === 'full'
          ? alignRows(fullRows(parts, instant, now, locale, uiLocale, msg))
          : alignRows([[line, renderStyle(style, parts, instant, now, locale, uiLocale)]], 2, 4);
      const tail: string[] = [];
      if (showRange) {
        tail.push(
          section(msg('basic.timestamp.rangeTitle', { weekStart: msg('basic.timestamp.weekStartMonday') })),
          alignRows(rangeRows(timeZone, instant.epochMs, uiLocale, msg)),
          msg('basic.timestamp.rangeNote'),
        );
      }
      blocks.push(joinBlocks([section(`#${index + 1} ${line}`), body, ...tail]));
      ctx.report({ percent: Math.min(99, Math.round(((index + 1) / lines.length) * 99)), phase: 'render' });
    });
    await emitText(ctx, 'timestamp.txt', joinBlocks(blocks));
    ctx.report({ percent: 100, phase: 'done' });
    return { extra: { inputs: lines.length, timezone: timeZone, style, unit, showRange: String(showRange), showNow: String(showNow) } };
  },
};

function rangeRows(timeZone: string, epochMs: number, uiLocale: MsgLocale, msg: Msg): Array<[string, string]> {
  const periods: Array<[PeriodUnit, string]> = [
    ['day', msg('basic.timestamp.periodDay')],
    ['week', msg('basic.timestamp.periodWeek')],
    ['month', msg('basic.timestamp.periodMonth')],
    ['year', msg('basic.timestamp.periodYear')],
  ];
  const rows: Array<[string, string]> = [];
  for (const [unit, period] of periods) {
    for (const [key, at] of [
      ['basic.timestamp.rangeStart', periodStartMs(timeZone, epochMs, unit, uiLocale)],
      ['basic.timestamp.rangeEnd', periodEndMs(timeZone, epochMs, unit, uiLocale)],
    ] as Array<[string, number]>) {
      rows.push([
        msg(key, { period }),
        msg('basic.timestamp.rangeValue', {
          epoch: String(Math.floor(at / SEC_MS)),
          local: formatInZone(timeZone, at, uiLocale),
        }),
      ]);
    }
  }
  return rows;
}

function zoned(timeZone: string, epochMs: number, uiLocale: MsgLocale): ZonedParts {
  return zonedParts(timeZone, epochMs, uiLocale);
}

function fullRows(
  parts: ZonedParts,
  instant: PreciseInstant,
  now: number,
  locale: LocaleCode,
  uiLocale: MsgLocale,
  msg: Msg,
): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    [msg('time.label.localTime'), formatZoneStamp(parts.timeZone, instant.epochMs, uiLocale)],
    [msg('basic.timestamp.unixSec'), String(Math.floor(instant.epochMs / SEC_MS))],
    [msg('basic.timestamp.unixMs'), String(instant.epochMs)],
    [msg('basic.timestamp.unixUs'), String(instant.epochUs)],
    [msg('basic.timestamp.unixNs'), String(instant.epochNs)],
    ['ISO 8601', isoInZone(parts.timeZone, instant.epochMs, true, uiLocale)],
    ['ISO 8601 (UTC)', utcIso(instant, uiLocale)],
    ['RFC 2822', rfc2822(instant.epochMs, parts.timeZone, uiLocale)],
    [msg('common.label.input'), instant.raw],
    [msg('basic.timestamp.detectedUnit'), instant.unit === 'text' ? msg('basic.timestamp.textTime') : msg('basic.timestamp.unixUnit', { unit: unitName(instant.unit, msg) })],
    [msg('time.label.timezone'), zoneText(parts, msg)],
    [msg('time.label.longDate'), longDate(instant.epochMs, parts.timeZone, uiLocale)],
    [msg('time.label.weekday'), weekdayPair(parts.weekday, uiLocale)],
    [msg('basic.timestamp.dayOfYear'), `${parts.dayOfYear} / ${parts.daysInYear}`],
    [msg('basic.timestamp.isoWeek'), `${parts.isoYear}-W${pad(parts.isoWeek, 2)}-${parts.isoWeekday}`],
    [msg('basic.timestamp.relativeNow'), relativePhrase(instant.epochMs - now, locale)],
    [msg('time.label.dst'), msg(parts.dst ? 'time.value.active' : 'time.value.inactive')],
  ];
  if (parts.millisecond > 0) rows.splice(3, 0, [msg('time.unit.ms'), pad(parts.millisecond, 3)]);
  if (fractionalSeconds(instant.epochNs)) {
    rows.splice(6, 0, [msg('basic.timestamp.preciseIso'), preciseIso(parts.timeZone, instant, uiLocale)]);
  }
  return rows;
}

function utcIso(instant: PreciseInstant, uiLocale: MsgLocale): string {
  const base = isoInZone('UTC', instant.epochMs, true, uiLocale).replace(/\+00:00$/, 'Z');
  const fraction = fractionalSeconds(instant.epochNs);
  return fraction ? `${base.slice(0, 19)}.${fraction}${base.slice(19)}` : base;
}

function renderStyle(
  style: TimestampStyle,
  parts: ZonedParts,
  instant: PreciseInstant,
  now: number,
  locale: LocaleCode,
  uiLocale: MsgLocale,
): string {
  switch (style) {
    case 'iso':
      return isoInZone(parts.timeZone, instant.epochMs, true, uiLocale);
    case 'date':
      return `${parts.year}-${pad(parts.month, 2)}-${pad(parts.day, 2)}`;
    case 'datetime':
      return formatInZone(parts.timeZone, instant.epochMs, uiLocale);
    case 'relative':
      return relativePhrase(instant.epochMs - now, locale);
    case 'chinese':
      return longDate(instant.epochMs, parts.timeZone, uiLocale);
    case 'both':
      return uiLocale.startsWith('zh')
        ? `日期时间：${formatInZone(parts.timeZone, instant.epochMs, uiLocale)}\nUnix 秒：${Math.floor(instant.epochMs / SEC_MS)}\nUnix 毫秒：${instant.epochMs}`
        : `Date/time: ${formatInZone(parts.timeZone, instant.epochMs, uiLocale)}\nUnix seconds: ${Math.floor(instant.epochMs / SEC_MS)}\nUnix milliseconds: ${instant.epochMs}`;
    default:
      return formatZoneStamp(parts.timeZone, instant.epochMs, uiLocale);
  }
}

const dateDiffTool: ToolImpl = {
  id: 'date-diff',
  async run(ctx): Promise<ToolResult> {
    const uiLocale = localeOf(ctx);
    const msg = makeMsg(uiLocale);
    const timeZone = assertTimeZone(optStr(ctx, 'timezone') || 'Asia/Shanghai', 'timezone', uiLocale);
    const now = nowOf(ctx);
    const locale = phraseLocale(uiLocale, optLocale(ctx));
    const unit = optSelect<DateUnit>(ctx, 'unit', DATE_UNITS, 'auto');
    const breakdown = optBool(ctx, 'breakdown', true);
    const includeEnd = optBool(ctx, 'includeEnd', false);
    const countWorkdays = optBool(ctx, 'countWorkdays', true);
    const weekend = parseWeekendSet(optStr(ctx, 'weekend') || '0,6', msg);
    const holidays = parseHolidayMap(optStr(ctx, 'holidays'), timeZone, now, uiLocale);
    const from = parseFlexPrecise(optStr(ctx, 'from') || 'now', { timeZone, field: 'from', fallbackNow: now }, uiLocale);
    const to = parseFlexPrecise(optStr(ctx, 'to') || 'now', { timeZone, field: 'to', fallbackNow: now }, uiLocale);
    const delta = to.epochMs - from.epochMs;
    const fromParts = zoned(timeZone, from.epochMs, uiLocale);
    const toParts = zoned(timeZone, to.epochMs, uiLocale);
    const span: CalendarSpan = calendarBreakdown(from.epochMs, to.epochMs, timeZone, uiLocale);
    const abs = Math.abs(delta);
    const firstIndex = Math.min(dayIndexOfInstant(timeZone, from.epochMs, uiLocale), dayIndexOfInstant(timeZone, to.epochMs, uiLocale));
    const wholeDays = Math.abs(dayIndexOfInstant(timeZone, to.epochMs, uiLocale) - dayIndexOfInstant(timeZone, from.epochMs, uiLocale));
    const countedDays = wholeDays + (includeEnd ? 1 : 0);
    const tally = countWorkdays ? tallyDayRange(firstIndex, countedDays, weekend, holidays) : null;
    const headRows: Array<[string, string]> = [
      [msg('basic.datediff.from'), `${from.raw} → ${formatZoneStamp(timeZone, from.epochMs, uiLocale)} · ${instantText(fromParts, msg)}`],
      [msg('basic.datediff.to'), `${to.raw} → ${formatZoneStamp(timeZone, to.epochMs, uiLocale)} · ${instantText(toParts, msg)}`],
      [msg('basic.datediff.direction'), delta === 0 ? msg('basic.datediff.dirSame') : delta > 0 ? msg('basic.datediff.dirForward') : msg('basic.datediff.dirBackward')],
    ];
    if (breakdown) {
      headRows.push([msg('basic.datediff.span'), `${delta < 0 ? '−' : ''}${spanText({ ...span, sign: 1 }, locale)}`]);
    }
    const blocks: string[] = [
      section(msg('common.label.result')),
      alignRows([
        [msg('basic.datediff.span'), `${delta < 0 ? '−' : ''}${spanText({ ...span, sign: 1 }, locale)}`],
        [msg('basic.datediff.direction'), delta === 0 ? msg('basic.datediff.dirSame') : delta > 0 ? msg('basic.datediff.dirForward') : msg('basic.datediff.dirBackward')],
        ...(unit !== 'auto' ? [[msg('basic.datediff.byUnit', { unit: optLabel(msg, 'dateDiff.unit', unit) }), `${signed(delta / divisorOf(unit), locale)} ${unitSuffix(unit, locale, msg)}`] as [string, string]] : []),
      ]),
      section(msg('basic.datediff.title', { zone: timeZone })),
      alignRows(headRows),
      section(msg('time.section.totals')),
      alignRows(
        (
          [
            ['ms', abs],
            ['seconds', abs / SEC_MS],
            ['minutes', abs / MIN_MS],
            ['hours', abs / HOUR_MS],
            ['days', abs / DAY_MS],
            ['weeks', abs / WEEK_MS],
          ] as Array<[DateUnit, number]>
        ).map(([key, value]) => [unitName(key, msg), `${formatNumber(value, locale)} ${unitSuffix(key, locale, msg)}`]),
      ),
      section(msg('basic.datediff.endTitle')),
      alignRows([
        [msg('basic.datediff.endLabel'), msg(includeEnd ? 'basic.datediff.endOn' : 'basic.datediff.endOff')],
        [msg('basic.datediff.endWithout'), `${formatNumber(wholeDays, locale)} ${unitSuffix('days', locale, msg)}`],
        [msg('basic.datediff.endWith'), `${formatNumber(wholeDays + 1, locale)} ${unitSuffix('days', locale, msg)}`],
        [msg('basic.datediff.endDiff'), msg('basic.datediff.endOne')],
      ]),
    ];
    if (tally) {
      const shown = tally.restList
        .slice(0, REST_LIST_SHOWN)
        .map((cell) => `${cell.key} ${weekdaySpelled(cell.weekday, uiLocale)}`)
        .join(restSep(uiLocale));
      const hidden = tally.restDays - Math.min(tally.restDays, REST_LIST_SHOWN);
      blocks.push(
        section(msg('basic.datediff.tallyTitle')),
        alignRows([
          [msg('extra.workdays.weekendLabel'), formatWeekendSet(weekend, uiLocale, msg)],
          [msg('basic.datediff.holidayDefined'), holidays.size ? msg('extra.workdays.holidaysCount', { count: holidays.size, list: [...holidays.keys()].slice(0, 6).join(restSep(uiLocale)), more: holidays.size > 6 ? msg('extra.workdays.more') : '' }) : msg('extra.workdays.holidaysNone')],
          [msg('basic.datediff.tallyTotal'), `${formatNumber(tally.total, locale)} ${unitSuffix('days', locale, msg)}`],
          [msg('basic.datediff.tallyWorkdays'), `${formatNumber(tally.workdays, locale)} ${unitSuffix('days', locale, msg)}`],
          [msg('basic.datediff.tallyWeekend'), `${formatNumber(tally.weekendDays, locale)} ${unitSuffix('days', locale, msg)}`],
          [msg('basic.datediff.tallyHoliday'), `${formatNumber(tally.holidayDays, locale)} ${unitSuffix('days', locale, msg)}`],
          [msg('basic.datediff.tallyList'), shown ? `${shown}${hidden > 0 ? msg('basic.datediff.tallyMore', { count: hidden }) : ''}` : msg('basic.datediff.tallyNone')],
        ]),
      );
      if (tally.truncated) blocks.push(msg('basic.datediff.tallyTruncated', { cap: DAY_TALLY_CAP }));
    }
    if (unit !== 'auto') {
      const divisor = divisorOf(unit);
      blocks.push(section(msg('basic.datediff.pickedUnit')), alignRows([[msg('basic.datediff.byUnit', { unit: optLabel(msg, 'dateDiff.unit', unit) }), `${signed(delta / divisor, locale)} ${unitSuffix(unit, locale, msg)}`]]));
    }
    if (!breakdown) {
      blocks.push(section(msg('basic.datediff.breakdownShort')), msg('basic.datediff.breakdownOff'));
    }
    const notes: string[] = [];
    if (fromParts.offsetMinutes !== toParts.offsetMinutes) {
      notes.push(
        msg('basic.datediff.noteDst', {
          zone: timeZone,
          from: offsetLabel(fromParts.offsetMinutes),
          to: offsetLabel(toParts.offsetMinutes),
          state: msg(toParts.dst ? 'basic.datediff.dstEnter' : 'basic.datediff.dstExit'),
        }),
      );
    }
    if (unit !== 'auto') notes.push(msg('basic.datediff.noteUnit', { unit: optLabel(msg, 'dateDiff.unit', unit) }));
    if (tally) {
      notes.push(
        msg('basic.datediff.noteTally', {
          convention: msg(includeEnd ? 'basic.datediff.endWith' : 'basic.datediff.endWithout'),
        }),
      );
    }
    if (notes.length) blocks.push(section(msg('common.section.notes')), notes.join('\n'));
    await emitText(ctx, 'date-diff.txt', joinBlocks(blocks));
    ctx.report({ percent: 100, phase: 'done' });
    return {
      extra: {
        timezone: timeZone,
        unit,
        breakdown: String(breakdown),
        milliseconds: String(delta),
        phrase: spanText(span, locale),
        includeEnd: String(includeEnd),
        daysExcludingEnd: String(wholeDays),
        daysIncludingEnd: String(wholeDays + 1),
        workdays: tally ? String(tally.workdays) : '',
      },
    };
  },
};

const REST_LIST_SHOWN = 4;

function restSep(uiLocale: MsgLocale): string {
  return uiLocale === 'en' ? ', ' : '、';
}

function formatWeekendSet(weekend: Set<number>, uiLocale: MsgLocale, msg: Msg): string {
  if (!weekend.size) return msg('extra.workdays.weekendNone');
  return [...weekend]
    .sort((a, b) => a - b)
    .map((day) => msg('extra.workdays.weekendItem', { day, name: weekdaySpelled(day, uiLocale) }))
    .join(restSep(uiLocale));
}

function divisorOf(unit: DateUnit): number {
  const map: Record<Exclude<DateUnit, 'auto'>, number> = {
    ms: SEC_MS,
    seconds: SEC_MS,
    minutes: MIN_MS,
    hours: HOUR_MS,
    days: DAY_MS,
    weeks: WEEK_MS,
  };
  if (unit === 'auto') return DAY_MS;
  return map[unit] ?? DAY_MS;
}

const dateMathTool: ToolImpl = {
  id: 'date-math',
  async run(ctx): Promise<ToolResult> {
    const uiLocale = localeOf(ctx);
    const msg = makeMsg(uiLocale);
    const timeZone = assertTimeZone(optStr(ctx, 'timezone') || 'Asia/Shanghai', 'timezone', uiLocale);
    const now = nowOf(ctx);
    const locale = phraseLocale(uiLocale, optLocale(ctx));
    const baseRaw = optStr(ctx, 'base') || 'now';
    const base = parseFlexPrecise(baseRaw, { timeZone, field: 'base', fallbackNow: now }, uiLocale);
    const direction = optSelect(ctx, 'direction', ['add', 'subtract'] as const, 'add');
    const unit = optSelect<MathUnit>(ctx, 'unit', MATH_UNITS, 'days');
    const magnitude = Math.abs(Math.round(optNum(ctx, 'value', 1)));
    const signedValue = direction === 'subtract' ? -magnitude : magnitude;
    const shifted = shiftCalendar(base.epochMs, timeZone, { [unit]: signedValue }, uiLocale);
    const result = zoned(timeZone, shifted.epochMs, uiLocale);
    const baseParts = zoned(timeZone, base.epochMs, uiLocale);
    const span = calendarBreakdown(base.epochMs, shifted.epochMs, timeZone, uiLocale);
    const skipWeekend = optBool(ctx, 'skipWeekend', false);
    const weekend = parseWeekendSet(optStr(ctx, 'weekend') || '0,6', msg);
    const holidays = parseHolidayMap(optStr(ctx, 'holidays'), timeZone, now, uiLocale);
    const roll = skipWeekend
      ? rollToWorkingDay(dayIndexOfInstant(timeZone, shifted.epochMs, uiLocale), weekend, holidays, 1)
      : null;
    const rolledMs = roll
      ? resolveWallTime(
          timeZone,
          {
            ...(dayCell(roll.index) as { year: number; month: number; day: number }),
            hour: result.hour,
            minute: result.minute,
            second: result.second,
          },
          uiLocale,
        ).epochMs + result.millisecond
      : shifted.epochMs;
    const blocks: string[] = [
      section(msg('common.label.result')),
      alignRows([
        [msg('common.label.result'), `${formatZoneStamp(timeZone, shifted.epochMs, uiLocale)} · ${instantText(result, msg)}`],
        ['ISO 8601', isoInZone(timeZone, shifted.epochMs, true, uiLocale)],
        [msg('basic.timestamp.unixSec'), String(Math.floor(shifted.epochMs / SEC_MS))],
      ]),
      section(msg('basic.datemath.title', { zone: timeZone })),
      alignRows([
        [msg('time.label.base'), `${baseRaw} → ${formatZoneStamp(timeZone, base.epochMs, uiLocale)} · ${instantText(baseParts, msg)}`],
        [msg('basic.datemath.action'), msg('basic.datemath.actionValue', { op: msg(direction === 'add' ? 'time.op.add' : 'time.op.sub'), magnitude, unit: mathUnitLabel(unit, magnitude, uiLocale, msg) })],
        [msg('common.label.result'), `${formatZoneStamp(timeZone, shifted.epochMs, uiLocale)} · ${instantText(result, msg)}`],
        [msg('basic.datemath.localDate'), `${result.year}-${pad(result.month, 2)}-${pad(result.day, 2)}`],
        ['ISO 8601', isoInZone(timeZone, shifted.epochMs, true, uiLocale)],
        [msg('time.label.longDate'), longDate(shifted.epochMs, timeZone, uiLocale)],
        [msg('time.label.weekday'), weekdayPair(result.weekday, uiLocale)],
        [msg('basic.timestamp.isoWeek'), `${result.isoYear}-W${pad(result.isoWeek, 2)}-${result.isoWeekday}`],
        [msg('basic.timestamp.dayOfYear'), `${result.dayOfYear} / ${result.daysInYear}`],
        [msg('basic.timestamp.unixSec'), String(Math.floor(shifted.epochMs / SEC_MS))],
        [msg('basic.timestamp.unixMs'), String(shifted.epochMs)],
        [msg('basic.datemath.fromBase'), `${signedValue < 0 ? '−' : '+'}${spanText({ ...span, sign: 1 }, locale)}`],
      ]),
    ];
    const notes: string[] = [];
    if (roll) {
      const rolled = zoned(timeZone, rolledMs, uiLocale);
      blocks.push(
        section(msg('basic.datemath.skipTitle')),
        alignRows([
          [msg('extra.workdays.weekendLabel'), formatWeekendSet(weekend, uiLocale, msg)],
          [msg('basic.datemath.skipDays'), formatNumber(roll.skipped.length, locale)],
          [
            msg('basic.datemath.skipList'),
            roll.skipped.length
              ? roll.skipped
                  .map((cell) => msg('basic.datemath.skipCell', { day: cell.key, name: weekdaySpelled(cell.weekday, uiLocale) }))
                  .join(restSep(uiLocale))
              : msg('basic.datemath.skipOff'),
          ],
          [msg('basic.datemath.skipResult'), `${formatZoneStamp(timeZone, rolledMs, uiLocale)} · ${instantText(rolled, msg)}`],
          [msg('time.label.weekday'), weekdayPair(rolled.weekday, uiLocale)],
          ['ISO 8601', isoInZone(timeZone, rolledMs, true, uiLocale)],
          [msg('basic.timestamp.unixSec'), String(Math.floor(rolledMs / SEC_MS))],
        ]),
      );
      notes.push(msg('basic.datemath.skipNote'));
    }
    if (shifted.clamped) {
      notes.push(
        msg('basic.datemath.noteClamp', {
          from: shifted.clampedFrom,
          again: shifted.clampedFrom,
          to: shifted.clampedTo,
        }),
      );
    }
    if (shifted.adjusted) {
      notes.push(msg('basic.datemath.noteAdjusted', { zone: timeZone }));
    }
    if (baseParts.dst !== result.dst) {
      notes.push(
        msg('basic.datemath.noteDst', {
          from: offsetLabel(baseParts.offsetMinutes),
          to: offsetLabel(result.offsetMinutes),
        }),
      );
    }
    if (notes.length) blocks.push(section(msg('common.section.notes')), notes.join('\n'));
    await emitText(ctx, 'date-math.txt', joinBlocks(blocks));
    ctx.report({ percent: 100, phase: 'done' });
    return {
      extra: {
        timezone: timeZone,
        unit,
        value: String(signedValue),
        clamped: String(shifted.clamped),
        result: formatInZone(timeZone, shifted.epochMs, uiLocale),
      },
    };
  },
};

const relativeTimeTool: ToolImpl = {
  id: 'relative-time',
  async run(ctx): Promise<ToolResult> {
    const uiLocale = localeOf(ctx);
    const msg = makeMsg(uiLocale);
    const timeZone = assertTimeZone(optStr(ctx, 'timezone') || 'Asia/Shanghai', 'timezone', uiLocale);
    const now = nowOf(ctx);
    const locale = phraseLocale(uiLocale, optLocale(ctx));
    const numeric = optSelect(ctx, 'style', ['auto', 'always'] as const, 'auto');
    const showCountdown = optBool(ctx, 'showCountdown', true);
    const target = parseFlexPrecise(optStr(ctx, 'input'), { timeZone, field: 'input', fallbackNow: now }, uiLocale);
    const baseRaw = optStr(ctx, 'base') || 'now';
    const base = parseFlexPrecise(baseRaw, { timeZone, field: 'base', fallbackNow: now }, uiLocale);
    const delta = target.epochMs - base.epochMs;
    const targetParts = zoned(timeZone, target.epochMs, uiLocale);
    const baseParts = zoned(timeZone, base.epochMs, uiLocale);
    const span = calendarBreakdown(base.epochMs, target.epochMs, timeZone, uiLocale);
    const phrase = relativePhrase(delta, locale, numeric);
    const other: LocaleCode = locale === 'zh-CN' ? 'en-US' : 'zh-CN';
    const altLocale: LocaleCode = uiLocale === 'en' ? locale : other;
    const altStyle: 'auto' | 'always' = uiLocale === 'en' ? (numeric === 'auto' ? 'always' : 'auto') : numeric;
    const rows: Array<[string, string]> = [
      [msg('basic.relative.phrase'), phrase],
      [msg('basic.datediff.direction'), delta === 0 ? msg('basic.relative.dirSame') : delta > 0 ? msg('basic.relative.dirFuture') : msg('basic.relative.dirPast')],
      [msg('basic.relative.target'), `${target.raw} → ${formatZoneStamp(timeZone, target.epochMs, uiLocale)} · ${instantText(targetParts, msg)}`],
      [msg('time.label.base'), `${baseRaw} → ${formatZoneStamp(timeZone, base.epochMs, uiLocale)} · ${instantText(baseParts, msg)}`],
      [msg('basic.relative.phraseAlt'), msg('basic.relative.phraseAltValue', { locale: altLocale, phrase: relativePhrase(delta, altLocale, altStyle) })],
      [msg('basic.relative.exactSpan'), `${delta < 0 ? '−' : ''}${spanText({ ...span, sign: 1 }, locale)}`],
      [msg('basic.relative.targetAbs'), msg('basic.relative.targetAbsValue', { iso: isoInZone(timeZone, target.epochMs, true, uiLocale), weekday: weekdaySpelled(targetParts.weekday, uiLocale) })],
      [msg('basic.relative.baseAbs'), isoInZone(timeZone, base.epochMs, true, uiLocale)],
      [msg('basic.relative.total'), msg('basic.relative.totalValue', { seconds: formatNumber(Math.abs(delta) / SEC_MS, locale), hours: formatNumber(Math.abs(delta) / HOUR_MS, locale), days: formatNumber(Math.abs(delta) / DAY_MS, locale) })],
      ['Unix', msg('time.value.secondsMs', { seconds: Math.floor(target.epochMs / SEC_MS), milliseconds: target.epochMs })],
    ];
    const blocks: Array<string | string[]> = [section(msg('basic.relative.title', { locale, zone: timeZone })), alignRows(rows)];
    if (showCountdown) {
      const absMs = Math.abs(delta);
      const wholeDays = Math.floor(absMs / DAY_MS);
      let restMs = absMs - wholeDays * DAY_MS;
      const hours = Math.floor(restMs / HOUR_MS);
      restMs -= hours * HOUR_MS;
      const minutes = Math.floor(restMs / MIN_MS);
      const seconds = Math.floor((restMs - minutes * MIN_MS) / SEC_MS);
      blocks.push(
        section(msg('basic.relative.countTitle')),
        alignRows([
          [msg('basic.relative.countState'), delta === 0 ? msg('basic.relative.countZero') : msg(delta > 0 ? 'basic.relative.countRemaining' : 'basic.relative.countElapsed')],
          [
            msg('basic.relative.countParts'),
            msg('basic.relative.countPartsValue', { days: wholeDays, hours, minutes, seconds }),
          ],
          [
            msg('basic.relative.countTotals'),
            msg('basic.relative.countTotalsValue', {
              days: formatNumber(absMs / DAY_MS, locale),
              hours: formatNumber(absMs / HOUR_MS, locale),
              minutes: formatNumber(absMs / MIN_MS, locale),
              seconds: formatNumber(absMs / SEC_MS, locale),
            }),
          ],
        ]),
      );
    }
    await emitText(ctx, 'relative-time.txt', joinBlocks(blocks));
    ctx.report({ percent: 100, phase: 'done' });
    return { extra: { locale, style: numeric, timezone: timeZone, phrase, showCountdown: String(showCountdown) } };
  },
};

export const timeBasicTools: ToolImpl[] = [timestampTool, dateDiffTool, dateMathTool, relativeTimeTool];
