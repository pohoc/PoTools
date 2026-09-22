import { EngineError } from '../errors.ts';
import type { ToolImpl, ToolResult } from '../types.ts';
import { localeOf, makeMsg } from '../lib/messages.ts';
import {
  DAY_MS,
  HOUR_MS,
  MIN_MS,
  SEC_MS,
  WEEK_MS,
  WEEKDAYS_EN,
  WEEKDAYS_EN_SHORT,
  WEEKDAYS_ZH,
  alignRows,
  assertTimeZone,
  bullet,
  chineseDate,
  daysInMonth,
  dayIndexOf,
  decimalTrim,
  displayWidth,
  emitText,
  formatInZone,
  formatNumber,
  formatZoneStamp,
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
  padTo,
  parseFlexPrecise,
  parseHolidayMap,
  parseWeekendSet,
  phraseLocale,
  resolveWallTime,
  resolutionDiffers,
  rfc2822,
  section,
  splitLines,
  unitMsgKey,
  zonedParts,
  type MsgLocale,
  type LocaleCode,
  type ZonedParts,
} from './time-core.ts';

type Msg = ReturnType<typeof makeMsg>;

const ZH_MSG = makeMsg('zh-CN');

function weekdayShort(weekday: number, msg: Msg): string {
  return msg(`time.dow.${((weekday % 7) + 7) % 7}`);
}

function dowName(weekday: number, msg: Msg, locale: LocaleCode): string {
  return locale === 'en-US' ? (WEEKDAYS_EN[((weekday % 7) + 7) % 7] ?? '') : msg(`time.dow.${((weekday % 7) + 7) % 7}`);
}

function weekdayLong(weekday: number, locale: LocaleCode): string {
  const index = ((weekday % 7) + 7) % 7;
  return locale === 'en-US' ? (WEEKDAYS_EN[index] ?? '') : (WEEKDAYS_ZH[index] ?? '');
}

function pluralOf(value: number | string): string {
  return Number(value) === 1 ? '' : 's';
}

function longDate(at: number, timeZone: string, uiLocale: MsgLocale): string {
  if (uiLocale !== 'en') return chineseDate(at, timeZone);
  return new Intl.DateTimeFormat('en', { dateStyle: 'long', timeStyle: 'medium', timeZone }).format(new Date(at));
}

interface DayCell {
  index: number;
  year: number;
  month: number;
  day: number;
  weekday: number;
}

function cellOfIndex(index: number): DayCell {
  const date = new Date(index * DAY_MS);
  return {
    index,
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    weekday: date.getUTCDay(),
  };
}

function dayKey(cell: DayCell): string {
  return `${pad(cell.year, 4)}-${pad(cell.month, 2)}-${pad(cell.day, 2)}`;
}

function cellText(cell: DayCell, msg: Msg): string {
  return msg('extra.workdays.cell', { day: dayKey(cell), weekday: weekdayShort(cell.weekday, msg) });
}

/* ── workdays ─────────────────────────────────────────────────────────────── */

const LIST_CAP = 120;
const SCAN_CAP = 9999 * 40;

function restReason(cell: DayCell, weekend: Set<number>, holidays: Map<string, string>, msg: Msg): string | null {
  const off = weekend.has(cell.weekday);
  const holiday = holidays.get(dayKey(cell));
  if (off && holiday) return msg('extra.workdays.restBoth', { holiday });
  if (off) return msg('extra.workdays.restWeekend');
  if (holiday) return msg('extra.workdays.restHoliday', { holiday });
  return null;
}

const workdaysTool: ToolImpl = {
  id: 'workdays',
  async run(ctx): Promise<ToolResult> {
    const uiLocale = localeOf(ctx);
    const msg = makeMsg(uiLocale);
    const timeZone = assertTimeZone(optStr(ctx, 'timezone') || 'Asia/Shanghai', 'timezone', uiLocale);
    const now = nowOf(ctx);
    const locale = phraseLocale(uiLocale, optLocale(ctx));
    const mode = optSelect(ctx, 'mode', ['add', 'count'] as const, 'add');
    const weekendRaw = optStr(ctx, 'weekend') || '0,6';
    const weekend = parseWeekendSet(weekendRaw, msg);
    const holidays = parseHolidayMap(optStr(ctx, 'holidays'), timeZone, now, uiLocale);
    const startRaw = optStr(ctx, 'start') || 'today';
    const start = parseFlexPrecise(startRaw, { timeZone, field: 'start', fallbackNow: now }, uiLocale);
    const startParts = zonedParts(timeZone, start.epochMs, uiLocale);
    const startIndex = dayIndexOf(startParts.year, startParts.month, startParts.day);
    const startCell = cellOfIndex(startIndex);
    const startRest = restReason(startCell, weekend, holidays, msg);
    const sep = msg('common.list.sep');

    let endIndex = startIndex;
    let working = 0;
    let restCount = 0;
    const skipped: string[] = [];
    const worked: string[] = [];
    const ranges: Array<{ from: number; to: number }> = [];
    let previousWorked = Number.NaN;
    let scanCapHit = false;
    let request = 0;
    let direction: 1 | -1 | 0 = 0;

    const take = (cell: DayCell): void => {
      const reason = restReason(cell, weekend, holidays, msg);
      if (reason) {
        restCount += 1;
        if (skipped.length < LIST_CAP) skipped.push(msg('extra.workdays.skippedLine', { cell: cellText(cell, msg), reason }));
      } else {
        working += 1;
        if (worked.length < LIST_CAP) worked.push(msg('extra.workdays.workedLine', { cell: cellText(cell, msg) }));
        if (Math.abs(previousWorked - cell.index) === 1) ranges[ranges.length - 1]!.to = cell.index;
        else ranges.push({ from: cell.index, to: cell.index });
        previousWorked = cell.index;
      }
    };

    if (mode === 'add') {
      request = Math.max(-9999, Math.min(9999, Math.round(optNum(ctx, 'days', 10))));
      direction = request < 0 ? -1 : 1;
      const target = Math.abs(request);
      for (let guard = 0; working < target && guard < SCAN_CAP; guard += 1) {
        const cell = cellOfIndex(endIndex + direction);
        if (cell.year < 1 || cell.year > 9999) {
          scanCapHit = true;
          break;
        }
        endIndex = cell.index;
        take(cell);
      }
      if (working < target) scanCapHit = true;
    } else {
      const todayParts = zonedParts(timeZone, now, uiLocale);
      const todayIndex = dayIndexOf(todayParts.year, todayParts.month, todayParts.day);
      direction = todayIndex < startIndex ? -1 : 1;
      endIndex = todayIndex;
      for (let index = Math.min(startIndex, todayIndex); index <= Math.max(startIndex, todayIndex); index += 1) {
        take(cellOfIndex(index));
      }
    }

    const resultCell = cellOfIndex(endIndex);
    const resultInstant = resolveWallTime(timeZone, {
      year: resultCell.year,
      month: resultCell.month,
      day: resultCell.day,
      hour: startParts.hour,
      minute: startParts.minute,
      second: startParts.second,
      millisecond: startParts.millisecond,
    }, uiLocale);
    const naturalDays = Math.abs(endIndex - startIndex);

    ctx.report({ percent: 45, phase: 'scan' });

    const blocks: string[] = [
      section(msg('extra.workdays.title', { zone: timeZone })),
      alignRows([
        [msg('extra.workdays.start'), msg('extra.workdays.startValue', { raw: startRaw, day: dayKey(startCell), weekday: weekdayLong(startCell.weekday, locale) })],
        [msg('extra.workdays.startState'), startRest ? msg('extra.workdays.restDay', { reason: startRest }) : msg('extra.workdays.workDay')],
        [msg('extra.workdays.mode'), mode === 'add' ? (direction < 0 ? msg('extra.workdays.modeBackward') : msg('extra.workdays.modeForward')) : msg('extra.workdays.modeCount')],
        ...(mode === 'add'
          ? [[
              msg('extra.workdays.requested'),
              request === 0
                ? msg('extra.workdays.requestedZero')
                : msg('extra.workdays.requestedCount', { sign: request < 0 ? '−' : '', count: formatNumber(Math.abs(request), locale) }),
            ] as [string, string]]
          : []),
        [msg('extra.workdays.range'), mode === 'count' ? msg('extra.workdays.rangeCount', { from: dayKey(cellOfIndex(Math.min(startIndex, endIndex))), to: dayKey(cellOfIndex(Math.max(startIndex, endIndex))) }) : msg('extra.workdays.rangeAdd', { from: dayKey(startCell), to: dayKey(resultCell) })],
        [msg('extra.workdays.weekendLabel'), weekend.size === 0 ? msg('extra.workdays.weekendNone') : [...weekend].sort((a, b) => a - b).map((d) => msg('extra.workdays.weekendItem', { day: d, name: weekdayShort(d, msg) })).join(sep)],
        [msg('extra.workdays.holidaysLabel'), holidays.size ? msg('extra.workdays.holidaysCount', { count: formatNumber(holidays.size, locale), list: [...holidays.keys()].slice(0, 6).join(sep), more: holidays.size > 6 ? msg('extra.workdays.more') : '' }) : msg('extra.workdays.holidaysNone')],
      ]),
      section(mode === 'add' ? msg('common.label.result') : msg('extra.workdays.statsResult')),
      alignRows(
        mode === 'add'
          ? [
              [msg('extra.workdays.targetDate'), msg('extra.workdays.cell', { day: dayKey(resultCell), weekday: weekdayLong(resultCell.weekday, locale) })],
              [msg('time.label.localTime'), formatZoneStamp(timeZone, resultInstant.epochMs, uiLocale)],
              ['ISO 8601', isoInZone(timeZone, resultInstant.epochMs, true, uiLocale)],
              [msg('time.label.longDate'), longDate(resultInstant.epochMs, timeZone, uiLocale)],
              [msg('extra.workdays.naturalSpan'), msg('extra.workdays.naturalSpanValue', { sign: direction < 0 ? '−' : '', days: formatNumber(naturalDays, locale), working: formatNumber(working, locale), rest: formatNumber(restCount, locale) })],
              [msg('basic.timestamp.unixSec'), String(Math.floor(resultInstant.epochMs / SEC_MS))],
            ]
          : [
              [msg('extra.workdays.workDay'), msg('time.value.daysCount', { value: formatNumber(working, locale), p: pluralOf(working) })],
              [msg('extra.workdays.restDayLabel'), msg('time.value.daysCount', { value: formatNumber(restCount, locale), p: pluralOf(restCount) })],
              [msg('basic.datediff.calendarDays'), msg('extra.workdays.naturalDaysValue', { days: formatNumber(naturalDays + 1, locale) })],
              [msg('extra.workdays.rangeFrom'), msg('extra.workdays.cell', { day: dayKey(cellOfIndex(Math.min(startIndex, endIndex))), weekday: weekdayLong(cellOfIndex(Math.min(startIndex, endIndex)).weekday, locale) })],
              [msg('extra.workdays.rangeTo'), msg('extra.workdays.cell', { day: dayKey(cellOfIndex(Math.max(startIndex, endIndex))), weekday: weekdayLong(cellOfIndex(Math.max(startIndex, endIndex)).weekday, locale) })],
              [msg('extra.workdays.share'), msg('extra.workdays.shareValue', { percent: formatNumber(Number(decimalTrim(naturalDays + 1 === 0 ? 0 : (working / (naturalDays + 1)) * 100, 1)), locale) })],
            ],
      ),
    ];

    const collapse = mode === 'add' && naturalDays > 30 && ranges.length > 0;
    if (mode === 'add' && worked.length) {
      if (collapse) {
        blocks.push(
          section(msg('extra.workdays.intervalSection', { count: formatNumber(working, locale) })),
          ranges
            .map((range) => {
              const lo = Math.min(range.from, range.to);
              const hi = Math.max(range.from, range.to);
              return lo === hi
                ? bullet(msg('extra.workdays.intervalSingle', { day: dayKey(cellOfIndex(lo)) }))
                : bullet(msg('extra.workdays.intervalLine', {
                    from: dayKey(cellOfIndex(lo)),
                    to: dayKey(cellOfIndex(hi)),
                    days: formatNumber(hi - lo + 1, locale),
                  }));
            })
            .join('\n'),
        );
      } else {
        blocks.push(
          section(msg('extra.workdays.workedList', { count: formatNumber(working, locale), trunc: worked.length >= LIST_CAP ? msg('extra.workdays.truncated') : '' })),
          worked.join('\n'),
        );
      }
    }
    if (skipped.length) {
      blocks.push(
        section(msg('extra.workdays.skippedList', { count: formatNumber(restCount, locale), trunc: skipped.length >= LIST_CAP ? msg('extra.workdays.truncated') : '' })),
        skipped.join('\n'),
      );
    }

    const notes: string[] = [];
    if (mode === 'count') {
      notes.push(msg('extra.workdays.noteCountHidden'));
      notes.push(msg('extra.workdays.noteCountClosed'));
    } else {
      notes.push(msg('extra.workdays.noteAddNext'));
      if (request < 0) notes.push(msg('extra.workdays.noteNegative'));
    }
    if (startRest && mode === 'add') {
      notes.push(msg('extra.workdays.noteStartRest', { day: dayKey(startCell), reason: startRest }));
    }
    if (resultInstant.adjusted) {
      notes.push(msg('extra.workdays.noteAdjusted', { zone: timeZone }));
    }
    if (scanCapHit) {
      notes.push(msg('extra.workdays.noteScanCap'));
    }
    if (collapse) notes.push(msg('extra.workdays.noteInterval', { days: formatNumber(naturalDays, locale) }));
    if (notes.length) blocks.push(section(msg('common.section.notes')), notes.join('\n'));

    await emitText(ctx, 'workdays.txt', joinBlocks(blocks));
    ctx.report({ percent: 100, phase: 'done' });
    return {
      extra: {
        mode,
        timezone: timeZone,
        start: dayKey(startCell),
        result: dayKey(resultCell),
        workingDays: String(working),
        skippedDays: String(restCount),
        naturalDays: String(naturalDays),
        holidays: String(holidays.size),
        weekend: weekendRaw,
      },
    };
  },
};


/* ── timezone-board ───────────────────────────────────────────────────────── */

const BOARD_STYLES = ['full', 'date', 'datetime'] as const;
type BoardStyle = (typeof BOARD_STYLES)[number];

function boardCell(style: BoardStyle, zone: string, epochMs: number, uiLocale: MsgLocale): string {
  if (style === 'date') return `${zonedParts(zone, epochMs, uiLocale).year}-${pad(zonedParts(zone, epochMs, uiLocale).month, 2)}-${pad(zonedParts(zone, epochMs, uiLocale).day, 2)}`;
  if (style === 'datetime') return formatInZone(zone, epochMs, uiLocale).slice(0, 16);
  return formatInZone(zone, epochMs, uiLocale);
}

const timezoneBoardTool: ToolImpl = {
  id: 'timezone-board',
  async run(ctx): Promise<ToolResult> {
    const uiLocale = localeOf(ctx);
    const msg = makeMsg(uiLocale);
    const now = nowOf(ctx);
    const style = optSelect<BoardStyle>(ctx, 'style', BOARD_STYLES, 'datetime');
    const locale = phraseLocale(uiLocale, optLocale(ctx));
    const rawLines = splitLines(optStr(ctx, 'zones'));
    if (!rawLines.length) {
      throw new EngineError('bad_request', msg('extra.board.errorEmpty'));
    }
    const valid: string[] = [];
    const invalid: Array<{ line: number; raw: string; message: string }> = [];
    rawLines.forEach((line, position) => {
      try {
        valid.push(assertTimeZone(line, 'zones', uiLocale));
      } catch (error) {
        invalid.push({
          line: position + 1,
          raw: line,
          message: error instanceof EngineError ? error.message : msg('extra.board.unknownZone'),
        });
      }
    });
    const reference = valid[0] ?? 'UTC';
    const showDayShift = optBool(ctx, 'showDayShift', true);
    const showOffsetDelta = optBool(ctx, 'showOffsetDelta', true);
    const atRaw = optStr(ctx, 'at') || 'now';
    const at = parseFlexPrecise(atRaw, { timeZone: reference, field: 'at', fallbackNow: now }, uiLocale);
    const epochMs = at.epochMs;
    const referenceParts = zonedParts(reference, epochMs, uiLocale);

    ctx.report({ percent: 40, phase: 'render' });

    const head = ['#', msg('time.label.timezone'), msg('time.label.localTime'), msg('time.label.weekday'), msg('time.label.offset'), msg('extra.board.headAbbrev'), msg('time.label.dst')];
    if (showOffsetDelta) head.push(msg('extra.board.headDelta'));
    if (showDayShift) head.push(msg('extra.board.headCrossDay'));
    const rows: string[][] = [];
    const referenceDay = dayIndexOf(referenceParts.year, referenceParts.month, referenceParts.day);
    const referenceOffset = referenceParts.offsetMinutes;
    valid.forEach((zone, position) => {
      const parts = zonedParts(zone, epochMs, uiLocale);
      const shift = dayIndexOf(parts.year, parts.month, parts.day) - referenceDay;
      const delta = (parts.offsetMinutes - referenceOffset) / 60;
      const row = [
        String(position + 1),
        zone,
        boardCell(style, zone, epochMs, uiLocale),
        weekdayShort(parts.weekday, msg),
        `UTC${offsetLabel(parts.offsetMinutes)}`,
        parts.abbrev,
        msg(parts.dst ? 'time.value.active' : 'time.value.inactive'),
      ];
      if (showOffsetDelta) {
        row.push(delta === 0 ? msg('extra.board.deltaZero') : msg('extra.board.delta', { sign: delta > 0 ? '+' : '−', hours: formatNumber(Math.abs(delta), locale) }));
      }
      if (showDayShift) {
        row.push(shift === 0 ? msg('extra.board.sameDay') : msg('extra.board.shift', { sign: shift > 0 ? '+' : '−', days: formatNumber(Math.abs(shift), locale), p: pluralOf(Math.abs(shift)) }));
      }
      rows.push(row);
    });

    const widths = head.map((title, column) =>
      Math.max(displayWidth(title), ...rows.map((row) => displayWidth(row[column] ?? ''))),
    );
    const renderRow = (cells: string[]): string =>
      `  ${cells.map((cell, column) => padTo(cell, widths[column] ?? displayWidth(cell))).join('  ').trimEnd()}`;
    const table = [renderRow(head), `  ${'─'.repeat(widths.reduce((sum, w) => sum + w + 2, 0) - 2)}`, ...rows.map(renderRow)];

    const offsets = valid.map((zone) => zonedParts(zone, epochMs, uiLocale).offsetMinutes);
    const dstZones = valid.filter((zone) => zonedParts(zone, epochMs, uiLocale).dst);
    const blocks: string[] = [
      section(msg('extra.board.title', { count: formatNumber(valid.length, locale), stamp: formatZoneStamp(reference, epochMs, uiLocale) })),
      alignRows([
        [msg('common.label.input'), `${atRaw} → ${isoInZone(reference, epochMs, true, uiLocale)}`],
        ['UTC', formatZoneStamp('UTC', epochMs, uiLocale)],
        [msg('extra.board.reference'), msg('extra.board.referenceValue', { zone: reference })],
        [msg('extra.board.style'), optLabel(msg, 'timezoneBoard.style', style)],
        [msg('extra.board.offsetRange'), offsets.length ? `UTC${offsetLabel(Math.min(...offsets))} ~ UTC${offsetLabel(Math.max(...offsets))}` : '—'],
        [msg('extra.board.dstZones'), dstZones.length ? dstZones.join(msg('common.list.sep')) : msg('common.value.none')],
      ]),
      section(msg('extra.board.table')),
      table.join('\n'),
    ];

    const notes: string[] = [msg('extra.board.noteHead')];
    if (showDayShift || showOffsetDelta) notes.push(msg('extra.board.deltaNote'));
    if (invalid.length) {
      notes.push(msg('extra.board.noteInvalid', { count: invalid.length }));
      blocks.push(
        section(msg('extra.board.invalidTitle', { count: invalid.length })),
        invalid.map((item) => msg('extra.board.invalidLine', { line: item.line, message: item.message })).join('\n'),
      );
    }
    if (!valid.length) {
      blocks.push(section(msg('common.section.hints')), msg('extra.board.hintNone'));
    }
    blocks.push(section(msg('common.section.notes')), notes.join('\n'));

    await emitText(ctx, 'timezone-board.txt', joinBlocks(blocks));
    ctx.report({ percent: 100, phase: 'done' });
    return {
      extra: {
        zones: String(valid.length),
        invalid: String(invalid.length),
        style,
        reference,
        at: isoInZone('UTC', epochMs, true, uiLocale),
        utc: formatInZone('UTC', epochMs, uiLocale),
      },
    };
  },
};

/* ── duration ─────────────────────────────────────────────────────────────── */

const DURATION_STYLES = ['all', 'hhmmss', 'iso', 'human', 'chinese'] as const;
type DurationStyle = (typeof DURATION_STYLES)[number];

function unitMs(unit: string): number {
  if (unit === 'min') return MIN_MS;
  if (unit === 'h') return HOUR_MS;
  if (unit === 'd') return DAY_MS;
  if (unit === 'ms') return 1;
  return SEC_MS;
}

function fractionOfMillis(millis: number): string {
  if (!millis) return '';
  return `.${String(millis).padStart(3, '0').replace(/0+$/, '')}`;
}

function isoDuration(ms: number): string {
  const abs = Math.abs(ms);
  const days = Math.floor(abs / DAY_MS);
  const hours = Math.floor((abs % DAY_MS) / HOUR_MS);
  const minutes = Math.floor((abs % HOUR_MS) / MIN_MS);
  const seconds = Math.floor((abs % MIN_MS) / SEC_MS);
  const millis = abs % SEC_MS;
  const fraction = millis ? `.${String(millis).padStart(3, '0').replace(/0+$/, '')}` : '';
  if (!abs) return 'PT0S';
  const date = days ? `${days}D` : '';
  const time =
    (hours ? `${hours}H` : '') + (minutes ? `${minutes}M` : '') + (seconds || fraction || !date ? `${seconds}${fraction}S` : '');
  return `${ms < 0 ? '-' : ''}P${date}${time ? `T${time}` : ''}`;
}

function wordDuration(ms: number, gap: string, msg: Msg): string {
  const abs = Math.abs(ms);
  const days = Math.floor(abs / DAY_MS);
  const hours = Math.floor((abs % DAY_MS) / HOUR_MS);
  const minutes = Math.floor((abs % HOUR_MS) / MIN_MS);
  const seconds = Math.floor((abs % MIN_MS) / SEC_MS);
  const millis = abs % SEC_MS;
  const pieces: string[] = [];
  if (days) pieces.push(msg('extra.duration.wDay', { n: days, p: pluralOf(days) }));
  if (hours) pieces.push(msg('extra.duration.wHour', { n: hours, p: pluralOf(hours) }));
  if (minutes) pieces.push(msg('extra.duration.wMinute', { n: minutes, p: pluralOf(minutes) }));
  if (seconds) pieces.push(msg('extra.duration.wSecond', { n: seconds, p: pluralOf(seconds) }));
  if (millis) pieces.push(msg('extra.duration.wMilli', { n: millis, p: pluralOf(millis) }));
  const body = pieces.join(gap || msg('extra.duration.joiner')) || msg('extra.duration.wSecond', { n: gap ? msg('extra.duration.zeroSpaced') : msg('extra.duration.zeroPlain'), p: 's' });
  return `${ms < 0 ? msg('extra.duration.negative') : ''}${body}`;
}

function spokenDuration(ms: number, locale: LocaleCode, msg: Msg): string {
  const abs = Math.abs(ms);
  const steps: Array<{ name: string; ms: number }> = [
    { name: 'second', ms: SEC_MS },
    { name: 'minute', ms: MIN_MS },
    { name: 'hour', ms: HOUR_MS },
    { name: 'day', ms: DAY_MS },
    { name: 'week', ms: WEEK_MS },
  ];
  let chosen = steps[0] ?? { name: 'second', ms: SEC_MS };
  for (const step of steps) {
    if (abs >= step.ms) chosen = step;
  }
  const value = Math.round(abs / chosen.ms);
  try {
    return new Intl.NumberFormat(locale, { style: 'unit', unit: chosen.name, unitDisplay: 'long' }).format(value);
  } catch {
    return locale === 'en-US' ? `${value} ${chosen.name}${value === 1 ? '' : 's'}` : `${value} ${msg(unitMsgKey(chosen.name))}`;
  }
}

const durationTool: ToolImpl = {
  id: 'duration',
  async run(ctx): Promise<ToolResult> {
    const uiLocale = localeOf(ctx);
    const msg = makeMsg(uiLocale);
    const raw = optStr(ctx, 'value');
    if (!raw) {
      throw new EngineError('bad_request', msg('extra.duration.errorEmpty'));
    }
    const cleaned = raw.replace(/[_\s]/g, '');
    if (!/^[+-]?\d+(?:\.\d+)?$/.test(cleaned)) {
      throw new EngineError('bad_request', msg('extra.duration.errorNumber', { raw }));
    }
    const numeric = Number(cleaned);
    const unit = optSelect(ctx, 'unit', ['s', 'min', 'h', 'd', 'ms'] as const, 's');
    const style = optSelect<DurationStyle>(ctx, 'style', DURATION_STYLES, 'human');
    const yearLength = optSelect(ctx, 'yearLength', ['365', '365.25', '366'] as const, '365.25');
    const locale = phraseLocale(uiLocale, optLocale(ctx));
    const basisKey = yearLength === '365' ? 'common' : yearLength === '366' ? 'leap' : 'average';
    const basisLabel = optLabel(msg, 'duration.yearLength', basisKey);
    const daysPerYear = Number(yearLength);
    const msPerYear = daysPerYear * DAY_MS;
    const msPerMonth = msPerYear / 12;
    if (!Number.isFinite(numeric) || Math.abs(numeric) > 1e15) {
      throw new EngineError('bad_request', msg('extra.duration.errorRange', { raw }));
    }
    const totalMs = Math.round(numeric * unitMs(unit));
    const abs = Math.abs(totalMs);
    const sign = totalMs < 0 ? '−' : '';
    const days = Math.floor(abs / DAY_MS);
    const totalHours = Math.floor(abs / HOUR_MS);
    const hours = totalHours % 24;
    const minutes = Math.floor((abs % HOUR_MS) / MIN_MS);
    const seconds = Math.floor((abs % MIN_MS) / SEC_MS);
    const millis = abs % SEC_MS;
    const hhmmss = `${pad(totalHours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}`;
    const withDays = msg('extra.duration.withDays', {
      days,
      hours: pad(hours, 2),
      minutes: pad(minutes, 2),
      seconds: pad(seconds, 2),
      fraction: fractionOfMillis(millis),
    });
    const basisYears = Math.floor(abs / msPerYear);
    const afterYears = abs - basisYears * msPerYear;
    const basisMonths = Math.floor(afterYears / msPerMonth);
    const afterMonths = afterYears - basisMonths * msPerMonth;
    const basisDays = Math.floor(afterMonths / DAY_MS);
    const afterDays = afterMonths - basisDays * DAY_MS;
    const basisHours = Math.floor(afterDays / HOUR_MS);
    const afterHours = afterDays - basisHours * HOUR_MS;
    const basisMinutes = Math.floor(afterHours / MIN_MS);
    const iso = isoDuration(totalMs);
    const unitLabel = msg(unitMsgKey(unit));

    ctx.report({ percent: 60, phase: 'render' });

    const variants: Record<Exclude<DurationStyle, 'all'>, Array<[string, string]>> = {
      hhmmss: [
        ['HH:MM:SS', `${sign}${hhmmss}`],
        [msg('extra.duration.withDaysLabel'), `${sign}${withDays}`],
        [msg('extra.duration.hoursMinutes'), `${sign}${pad(totalHours, 2)}:${pad(minutes, 2)}`],
      ],
      iso: [
        ['ISO 8601', iso],
        [msg('extra.duration.isoSingle'), `${sign}PT${decimalTrim(abs / HOUR_MS, 2)}H`],
      ],
      human: [
        [msg('extra.duration.spokenA'), spokenDuration(totalMs, uiLocale === 'en' ? 'en-US' : 'zh-CN', msg)],
        [msg('extra.duration.spokenB'), uiLocale === 'en' ? wordDuration(totalMs, ' ', msg) : spokenDuration(totalMs, 'en-US', msg)],
      ],
      chinese: [
        [msg('extra.duration.words'), wordDuration(totalMs, '', msg)],
        [msg('extra.duration.wordsSpaced'), wordDuration(totalMs, ' ', msg)],
      ],
    };
    const shown: Exclude<DurationStyle, 'all'>[] =
      style === 'all' ? ['hhmmss', 'iso', 'human', 'chinese'] : [style as Exclude<DurationStyle, 'all'>];

    // Non-complete styles are copy-friendly single-value outputs. The full
    // report is opt-in through the explicit “全部” style.
    if (style !== 'all') {
      const output = variants[style as Exclude<DurationStyle, 'all'>]?.[0]?.[1] ?? '';
      await emitText(ctx, 'duration.txt', output);
      ctx.report({ percent: 100, phase: 'done' });
      return { extra: { style, unit } };
    }

    const blocks: string[] = [
      section(msg('extra.duration.title', { value: decimalTrim(Math.abs(numeric), 9), unit: unitLabel })),
      alignRows([
        [msg('common.label.input'), msg('extra.duration.inputValue', { raw, unit, label: unitLabel })],
        [msg('extra.duration.totalMs'), `${sign}${formatNumber(abs, locale)}`],
        [msg('extra.duration.totalSec'), `${sign}${decimalTrim(abs / SEC_MS, 6)}`],
        [msg('basic.datediff.direction'), totalMs === 0 ? msg('extra.duration.dirZero') : totalMs < 0 ? msg('extra.duration.dirNegative') : msg('extra.duration.dirPositive')],
      ]),
    ];
    for (const key of shown) {
      blocks.push(section(variantTitle(key, msg)), alignRows(variants[key] ?? []));
    }
    blocks.push(
      section(msg('extra.duration.basisSection')),
      alignRows([
        [msg('extra.duration.basisLabel'), msg('extra.duration.basisValue', { label: basisLabel, days: formatNumber(daysPerYear, locale) })],
        [
          msg('extra.duration.brokenLabel'),
          `${sign}${msg('extra.duration.brokenValue', {
            years: formatNumber(basisYears, locale),
            months: formatNumber(basisMonths, locale),
            days: formatNumber(basisDays, locale),
            hours: pad(basisHours, 2),
            minutes: pad(basisMinutes, 2),
            seconds: `${pad(Math.floor((afterHours - basisMinutes * MIN_MS) / SEC_MS), 2)}${fractionOfMillis(Math.round(afterHours - basisMinutes * MIN_MS) % SEC_MS)}`,
          })}`,
        ],
      ]),
    );
    if (style === 'all') {
      blocks.push(
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
            ] as Array<[string, number]>
          ).map(([label, value]) => [msg(unitMsgKey(label)), formatNumber(value, locale)]),
        ),
      );
      blocks.push(
        section(msg('common.section.notes')),
        [msg('extra.duration.noteHhmmss'), msg('extra.duration.noteIso'), msg('extra.duration.noteBasis')].join('\n'),
      );
    } else {
      blocks.push(
        section(msg('common.section.notes')),
        [msg('extra.duration.noteStyle', { style: optLabel(msg, 'duration.style', style) }), msg('extra.duration.noteBasis')].join('\n'),
      );
    }

    await emitText(ctx, 'duration.txt', joinBlocks(blocks));
    ctx.report({ percent: 100, phase: 'done' });
    return {
      extra: {
        unit,
        style,
        milliseconds: String(totalMs),
        seconds: String(decimalTrim(abs / SEC_MS, 6)),
        hhmmss: `${sign}${hhmmss}`,
        iso,
        chinese: wordDuration(totalMs, '', msg),
      },
    };
  },
};

function variantTitle(key: Exclude<DurationStyle, 'all'>, msg: Msg): string {
  if (key === 'hhmmss') return msg('extra.duration.styleHhmmss');
  if (key === 'iso') return msg('extra.duration.styleIso');
  if (key === 'human') return msg('extra.duration.styleHuman');
  return msg('extra.duration.styleWords');
}

/* ── cron ─────────────────────────────────────────────────────────────────── */

const CRON_EXAMPLE = '0 9 * * 1-5';

function cronError(msg: Msg, label: string, raw: string, reason: string, expression: string): EngineError {
  return new EngineError(
    'bad_request',
    msg('extra.cron.errorField', { expression, label, raw, reason, example: CRON_EXAMPLE }),
  );
}

function sequence(min: number, max: number): Set<number> {
  const set = new Set<number>();
  for (let value = min; value <= max; value += 1) set.add(value);
  return set;
}

function parseNumberField(
  msg: Msg,
  raw: string,
  min: number,
  max: number,
  label: string,
  expression: string,
  allowQuestion: boolean,
): { values: Set<number>; all: boolean } {
  const text = raw.trim();
  if (!text) throw cronError(msg, label, raw, msg('extra.cron.reasonEmpty'), expression);
  if (text === '*' || (text === '?' && allowQuestion)) return { values: sequence(min, max), all: true };
  if (text === '?') throw cronError(msg, label, raw, msg('extra.cron.reasonQuestion'), expression);
  const values = new Set<number>();
  for (const piece of text.split(',')) {
    const token = piece.trim();
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(token);
    if (!match) throw cronError(msg, label, token, msg('extra.cron.reasonSyntax'), expression);
    const base = match[1] ?? '*';
    const stepText = match[2];
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw cronError(msg, label, token, msg('extra.cron.reasonStep'), expression);
    let lo = min;
    let hi = max;
    if (base !== '*') {
      const bounds = base.split('-');
      lo = Number(bounds[0]);
      hi = bounds.length > 1 && bounds[1] !== undefined ? Number(bounds[1]) : stepText === undefined ? lo : max;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) throw cronError(msg, label, token, msg('extra.cron.reasonInteger'), expression);
    if (lo < min || lo > max || hi < min || hi > max) {
      throw cronError(msg, label, token, msg('extra.cron.reasonRange', { min, max }), expression);
    }
    if (hi < lo) throw cronError(msg, label, token, msg('extra.cron.reasonOrder'), expression);
    for (let value = lo; value <= hi; value += step) values.add(value);
  }
  if (!values.size) throw cronError(msg, label, raw, msg('extra.cron.reasonNone'), expression);
  return { values, all: false };
}

type DaySpecial =
  | { kind: 'lastDom' }
  | { kind: 'lastWeekday' }
  | { kind: 'nearestWeekday'; day: number }
  | { kind: 'lastDow'; dow: number }
  | { kind: 'nth'; dow: number; nth: number };

interface CronDayField {
  raw: string;
  all: boolean;
  values: Set<number>;
  special: DaySpecial | null;
}

function parseDayField(
  msg: Msg,
  raw: string,
  field: 'dom' | 'dow',
  expression: string,
): CronDayField {
  const label = field === 'dom' ? msg('extra.cron.fieldDay') : msg('time.label.weekday');
  const min = field === 'dom' ? 1 : 0;
  const max = field === 'dom' ? 31 : 7;
  const text = raw.trim();
  const base = { raw: text, all: false, values: new Set<number>(), special: null as DaySpecial | null };
  if (!text) throw cronError(msg, label, raw, msg('extra.cron.reasonEmpty'), expression);
  if (text === '*' || text === '?') return { ...base, all: true, values: sequence(min, max) };
  const upper = text.toUpperCase();
  if (/[LW#]/.test(upper)) {
    if (upper.includes(',')) {
      throw cronError(msg, label, text, msg('extra.cron.reasonMixed'), expression);
    }
    if (field === 'dom') {
      if (upper === 'L') return { ...base, special: { kind: 'lastDom' } };
      if (upper === 'LW') return { ...base, special: { kind: 'lastWeekday' } };
      const nearest = /^(\d{1,2})W$/.exec(upper);
      const day = nearest ? Number(nearest[1]) : Number.NaN;
      if (!Number.isInteger(day) || day < 1 || day > 31) {
        throw cronError(msg, label, text, msg('extra.cron.reasonNearest'), expression);
      }
      return { ...base, special: { kind: 'nearestWeekday', day } };
    }
    if (upper === 'L') return { ...base, special: { kind: 'lastDow', dow: 6 } };
    const last = /^([0-7])L$/.exec(upper);
    if (last) return { ...base, special: { kind: 'lastDow', dow: ((Number(last[1]) % 7) + 7) % 7 } };
    const nth = /^([0-7])#([1-5])$/.exec(upper);
    if (nth) {
      return {
        ...base,
        special: { kind: 'nth', dow: ((Number(nth[1]) % 7) + 7) % 7, nth: Number(nth[2]) },
      };
    }
    throw cronError(msg, label, text, msg('extra.cron.reasonDow'), expression);
  }
  const parsed = parseNumberField(msg, text, min, max, label, expression, true);
  const values = new Set<number>(parsed.values);
  if (field === 'dow' && values.has(7)) {
    values.delete(7);
    values.add(0);
  }
  return { ...base, values, all: parsed.all };
}

function describeValues(values: Set<number>, min: number, max: number): string {
  if (values.size >= max - min + 1) return '*';
  const sorted = [...values].sort((a, b) => a - b);
  let uniform = sorted.length > 2;
  let step = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = (sorted[i] ?? 0) - (sorted[i - 1] ?? 0);
    if (i === 1) step = gap;
    else if (gap !== step) uniform = false;
  }
  if (uniform && step > 1 && (sorted[0] ?? 0) === min) return `*/${step}`;
  const groups: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && (sorted[j + 1] ?? 0) === (sorted[j] ?? 0) + 1) j += 1;
    const lo = sorted[i] ?? 0;
    const hi = sorted[j] ?? 0;
    groups.push(lo === hi ? String(lo) : `${lo}-${hi}`);
    i = j + 1;
  }
  return groups.join(',');
}

interface CronPlan {
  expression: string;
  second: Set<number>;
  minute: Set<number>;
  hour: Set<number>;
  month: Set<number>;
  dom: CronDayField;
  dow: CronDayField;
  hasSeconds: boolean;
}

function parseCron(msg: Msg, expression: string): CronPlan {
  const tokens = expression.split(/\s+/).filter(Boolean);
  if (tokens.length !== 5 && tokens.length !== 6) {
    throw new EngineError('bad_request', msg('extra.cron.errorFields', { expression, count: tokens.length, example: CRON_EXAMPLE }));
  }
  const hasSeconds = tokens.length === 6;
  const second = hasSeconds
    ? parseNumberField(msg, tokens[5] ?? '', 0, 59, msg('extra.cron.fieldSecond'), expression, false).values
    : new Set<number>([0]);
  return {
    expression,
    second,
    minute: parseNumberField(msg, tokens[0] ?? '', 0, 59, msg('extra.cron.fieldMinute'), expression, false).values,
    hour: parseNumberField(msg, tokens[1] ?? '', 0, 23, msg('extra.cron.fieldHour'), expression, false).values,
    month: parseNumberField(msg, tokens[3] ?? '', 1, 12, msg('extra.cron.fieldMonth'), expression, false).values,
    dom: parseDayField(msg, tokens[2] ?? '*', 'dom', expression),
    dow: parseDayField(msg, tokens[4] ?? '*', 'dow', expression),
    hasSeconds,
  };
}

function specialGloss(special: DaySpecial, msg: Msg): string {
  if (special.kind === 'lastDom') return msg('extra.cron.glossLastDom');
  if (special.kind === 'lastWeekday') return msg('extra.cron.glossLastWeekday');
  if (special.kind === 'nearestWeekday') return msg('extra.cron.glossNearest', { day: special.day });
  if (special.kind === 'lastDow') return msg('extra.cron.glossLastDow', { dow: weekdayShort(special.dow, msg) });
  return msg('extra.cron.glossNth', { nth: special.nth, dow: weekdayShort(special.dow, msg) });
}

function nearestWeekday(year: number, month: number, target: number, dim: number): number {
  const clamped = Math.min(Math.max(target, 1), dim);
  const weekday = new Date(Date.UTC(year, month - 1, clamped)).getUTCDay();
  if (weekday >= 1 && weekday <= 5) return clamped;
  if (weekday === 6) return clamped - 1 >= 1 ? clamped - 1 : clamped + 2 <= dim ? clamped + 2 : 0;
  return clamped + 1 <= dim ? clamped + 1 : clamped - 2 >= 1 ? clamped - 2 : 0;
}

function lastWeekday(year: number, month: number, dim: number): number {
  for (let day = dim; day >= 1; day -= 1) {
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    if (weekday >= 1 && weekday <= 5) return day;
  }
  return 0;
}

function domMatches(year: number, month: number, day: number, field: CronDayField): boolean {
  const dim = daysInMonth(year, month);
  const special = field.special;
  if (special) {
    if (special.kind === 'lastDom') return day === dim;
    if (special.kind === 'lastWeekday') return day === lastWeekday(year, month, dim);
    if (special.kind === 'nearestWeekday') return day === nearestWeekday(year, month, special.day, dim);
    return false;
  }
  return field.values.has(day);
}

function dowMatches(year: number, month: number, day: number, field: CronDayField): boolean {
  const dim = daysInMonth(year, month);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const special = field.special;
  if (special) {
    if (special.kind === 'lastDow') return weekday === special.dow && day + 7 > dim;
    if (special.kind === 'nth') return weekday === special.dow && Math.floor((day - 1) / 7) + 1 === special.nth;
    return false;
  }
  return field.values.has(weekday);
}

function dayMatches(year: number, month: number, day: number, plan: CronPlan): boolean {
  const domRestricted = plan.dom.special !== null || !plan.dom.all;
  const dowRestricted = plan.dow.special !== null || !plan.dow.all;
  if (domRestricted && dowRestricted) return domMatches(year, month, day, plan.dom) || dowMatches(year, month, day, plan.dow);
  if (domRestricted) return domMatches(year, month, day, plan.dom);
  if (dowRestricted) return dowMatches(year, month, day, plan.dow);
  return true;
}

function pickTime(
  hour: number,
  minute: number,
  second: number,
  plan: CronPlan,
): { hour: number; minute: number; second: number } | null {
  for (let h = hour; h <= 23; h += 1) {
    if (!plan.hour.has(h)) continue;
    for (let m = h === hour ? minute : 0; m <= 59; m += 1) {
      if (!plan.minute.has(m)) continue;
      for (let s = h === hour && m === minute ? second : 0; s <= 59; s += 1) {
        if (plan.second.has(s)) return { hour: h, minute: m, second: s };
      }
    }
  }
  return null;
}

interface CronRun {
  epochMs: number;
  wall: string;
  skipped: string | null;
}

function findRuns(
  zone: string,
  startMs: number,
  plan: CronPlan,
  want: number,
  uiLocale: MsgLocale,
  horizonYears = 8,
): { runs: CronRun[]; skipped: string[] } {
  const runs: CronRun[] = [];
  const skipped: string[] = [];
  const first = zonedParts(zone, startMs + SEC_MS, uiLocale);
  let year = first.year;
  let month = first.month;
  let day = first.day;
  let hour = first.hour;
  let minute = first.minute;
  let second = first.second;
  const horizon = dayIndexOf(Math.min(9999, year + horizonYears), month, day);
  const minHour = Math.min(...plan.hour);
  const minMinute = Math.min(...plan.minute);
  const minSecond = Math.min(...plan.second);
  let guard = 0;
  while (runs.length < want && guard < 400000) {
    guard += 1;
    if (year > 9999 || dayIndexOf(year, month, day) > horizon) break;
    if (!plan.month.has(month)) {
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
      day = 1;
      hour = minHour;
      minute = minMinute;
      second = minSecond;
      continue;
    }
    const dim = daysInMonth(year, month);
    const hit = day <= dim && plan.month.has(month) && dayMatches(year, month, day, plan);
    if (hit) {
      const picked = pickTime(hour, minute, second, plan);
      if (picked) {
        const resolved = resolveWallTime(zone, { ...picked, year, month, day }, uiLocale);
        const back = zonedParts(zone, resolved.epochMs, uiLocale);
        const faithful =
          !resolved.adjusted &&
          back.year === year &&
          back.month === month &&
          back.day === day &&
          back.hour === picked.hour &&
          back.minute === picked.minute &&
          back.second === picked.second;
        hour = picked.hour;
        minute = picked.minute;
        second = picked.second;
        if (faithful && resolved.epochMs > startMs) {
          runs.push({
            epochMs: resolved.epochMs,
            wall: `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)} ${pad(picked.hour, 2)}:${pad(picked.minute, 2)}:${pad(picked.second, 2)}`,
            skipped: null,
          });
        } else if (!faithful && skipped.length < 8 && !resolved.adjusted) {
          skipped.push(`${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)} ${pad(picked.hour, 2)}:${pad(picked.minute, 2)}:${pad(picked.second, 2)}`);
        }
        second += 1;
        if (second > 59) {
          second = 0;
          minute += 1;
        }
        if (minute > 59) {
          minute = 0;
          hour += 1;
        }
        if (hour > 23) {
          hour = 0;
          day += 1;
          if (day > dim) {
            day = 1;
            month += 1;
            if (month > 12) {
              month = 1;
              year += 1;
            }
          }
        }
        continue;
      }
    }
    day += 1;
    hour = 0;
    minute = 0;
    second = 0;
    if (day > dim) {
      day = 1;
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }
  }
  return { runs, skipped };
}

const CRON_MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@hourly': '0 * * * *',
};
const CRON_REBOOT = '@reboot';
const VALUE_CAP = 12;
const CLOCK_CAP = 12;

interface FieldShape {
  values: number[];
  all: boolean;
  every: number | null;
  single: number | null;
  run: { lo: number; hi: number } | null;
}

function shapeOf(values: Set<number>, min: number, max: number): FieldShape {
  const sorted = [...values].filter((v) => v >= min && v <= max).sort((a, b) => a - b);
  const size = max - min + 1;
  let every: number | null = null;
  if (sorted.length > 1 && sorted[0] === min) {
    const step = (sorted[1] ?? 0) - (sorted[0] ?? 0);
    if (step > 1 && sorted.every((v, i) => v === min + i * step) && (sorted[sorted.length - 1] ?? 0) + step > max) {
      every = step;
    }
  }
  let run: { lo: number; hi: number } | null = null;
  if (sorted.length > 1 && sorted.every((v, i) => v === (sorted[0] ?? 0) + i)) {
    run = { lo: sorted[0] ?? 0, hi: sorted[sorted.length - 1] ?? 0 };
  }
  return { values: sorted, all: sorted.length === size, every, single: sorted.length === 1 ? (sorted[0] ?? null) : null, run };
}

function listCompact(values: number[], cap: number): string {
  const groups: string[] = [];
  let i = 0;
  while (i < values.length) {
    let j = i;
    while (j + 1 < values.length && values[j + 1] === (values[j] ?? 0) + 1) j += 1;
    const lo = values[i] ?? 0;
    const hi = values[j] ?? 0;
    groups.push(lo === hi ? String(lo) : `${lo}-${hi}`);
    i = j + 1;
  }
  if (groups.length <= cap) return groups.join(',');
  return `${groups.slice(0, cap).join(',')}…`;
}

function expandValues(values: number[], msg: Msg, locale: LocaleCode): string {
  if (!values.length) return msg('extra.cron.fvNone');
  if (values.length <= VALUE_CAP) return values.join(',');
  return msg('extra.cron.fvCount', {
    head: values.slice(0, VALUE_CAP).join(','),
    count: formatNumber(values.length, locale),
  });
}

function clockText(hour: number, minute: number, second: number, withSeconds: boolean, h12: boolean): string {
  const tail = withSeconds ? `:${pad(second, 2)}` : '';
  if (!h12) return `${pad(hour, 2)}:${pad(minute, 2)}${tail}`;
  const meridiem = hour >= 12 ? 'PM' : 'AM';
  const base = hour % 12 === 0 ? 12 : hour % 12;
  return `${base}:${pad(minute, 2)}${tail} ${meridiem}`;
}

function clockList(plan: CronPlan, sh: CronShapes, msg: Msg, locale: LocaleCode, h12: boolean): string | null {
  const combos: string[] = [];
  for (const hour of sh.hour.values) {
    for (const minute of sh.minute.values) {
      for (const second of plan.hasSeconds ? sh.second.values : [0]) {
        if (combos.length >= CLOCK_CAP) return null;
        combos.push(clockText(hour, minute, second, plan.hasSeconds, h12));
      }
    }
  }
  return combos.length ? combos.join(msg('common.list.sep')) : null;
}

function monthNames(values: number[], msg: Msg, locale: LocaleCode): string {
  if (locale === 'en-US') {
    return values
      .map((v) => new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2021, v - 1, 2))))
      .join(msg('common.list.sep'));
  }
  return values.map((v) => msg('extra.cron.monthItem', { n: v })).join(msg('common.list.sep'));
}

function dowNames(values: number[], msg: Msg, locale: LocaleCode): string {
  return values.map((v) => (locale === 'en-US' ? (WEEKDAYS_EN[v % 7] ?? '') : msg(`time.dow.${v % 7}`))).join(msg('common.list.sep'));
}

function timeFrequency(plan: CronPlan, sh: CronShapes, msg: Msg, locale: LocaleCode): string | null {
  const n = (value: number): string => formatNumber(value, locale);
  if (sh.minute.all && sh.hour.all) {
    if (plan.hasSeconds && sh.second.every !== null) return msg('extra.cron.sEveryNSeconds', { n: n(sh.second.every) });
    if (plan.hasSeconds && sh.second.all) return msg('extra.cron.sEverySecond');
    if (!plan.hasSeconds) return msg('extra.cron.sEveryMinute');
    return null;
  }
  if (sh.minute.every !== null && sh.hour.all) {
    if (plan.hasSeconds && sh.second.single !== 0) {
      return msg('extra.cron.sEveryNMinutesSecond', { n: n(sh.minute.every), s: n(sh.second.single ?? 0) });
    }
    return msg('extra.cron.sEveryNMinutes', { n: n(sh.minute.every) });
  }
  if (sh.minute.all && sh.hour.every !== null) return msg('extra.cron.sEveryNHours', { n: n(sh.hour.every) });
  if (sh.minute.all && sh.hour.single !== null) return msg('extra.cron.sMinutePastHour', { h: n(sh.hour.single) });
  if (sh.minute.every !== null && sh.hour.single !== null) {
    return msg('extra.cron.sStepPastHour', { h: n(sh.hour.single), n: n(sh.minute.every) });
  }
  if (sh.minute.single !== null && sh.hour.all) return msg('extra.cron.sEveryHourMinute', { m: n(sh.minute.single) });
  if (sh.minute.single !== null && sh.hour.every !== null) {
    return msg('extra.cron.sEveryNHoursMinute', { n: n(sh.hour.every), m: n(sh.minute.single) });
  }
  return null;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function nthText(nth: number, msg: Msg): string {
  return msg(`extra.cron.ord${Math.min(5, Math.max(1, nth))}`);
}

function domClause(plan: CronPlan, sh: CronShapes, msg: Msg, locale: LocaleCode): string {
  const mp = sh.month.all
    ? msg('extra.cron.mpEvery')
    : msg('extra.cron.mpOf', { months: monthNames(sh.month.values, msg, locale) });
  const special = plan.dom.special;
  if (special) {
    if (special.kind === 'lastDom') return msg('extra.cron.wLastDom');
    if (special.kind === 'lastWeekday') return msg('extra.cron.wLastWeekday');
    if (special.kind === 'nearestWeekday') return msg('extra.cron.wNearest', { day: special.day });
    return msg('extra.cron.wDow', { dow: dowName(special.dow, msg, locale) });
  }
  return msg('extra.cron.wDom', { mp, me: mp, dom: listCompact(sh.dom.values, 8) });
}

function dowClause(plan: CronPlan, sh: CronShapes, msg: Msg, locale: LocaleCode): string {
  const special = plan.dow.special;
  if (special) {
    if (special.kind === 'lastDow') return msg('extra.cron.wLastDow', { dow: dowName(special.dow, msg, locale) });
    if (special.kind === 'nth') {
      return msg('extra.cron.wNth', { ord: nthText(special.nth, msg), dow: dowName(special.dow, msg, locale) });
    }
    return msg('extra.cron.wLastDom');
  }
  const values = sh.dow.values;
  if (values.length === 5 && values[0] === 1 && values[4] === 5) return msg('extra.cron.wWeekday');
  if (values.length === 1) return msg('extra.cron.wDow', { dow: dowName(values[0] ?? 0, msg, locale) });
  return msg('extra.cron.wDows', { dows: dowNames(values, msg, locale) });
}

function cronSentence(plan: CronPlan, sh: CronShapes, msg: Msg, locale: LocaleCode, uiLocale: MsgLocale): string {
  const restrictedDom = plan.dom.special !== null || !plan.dom.all;
  const restrictedDow = plan.dow.special !== null || !plan.dow.all;
  const restricted = restrictedDom || restrictedDow || !sh.month.all;
  const h12 = uiLocale === 'en';
  const descriptive = msg('extra.cron.sDescTime', {
    ml: listCompact(sh.minute.values, 8),
    hl: listCompact(sh.hour.values, 8),
  });
  if (!restricted) {
    const frequency = timeFrequency(plan, sh, msg, locale);
    if (frequency) return frequency;
    const clocks = clockList(plan, sh, msg, locale, false);
    if (clocks === null) return uiLocale === 'en' ? `${descriptive}.` : descriptive;
    if (sh.minute.single === 0 && sh.hour.single !== null && !plan.hasSeconds) {
      return msg('extra.cron.sWhen', {
        when: msg('extra.cron.wEveryDay'),
        time: clockList(plan, sh, msg, locale, uiLocale === 'en') ?? clocks,
      });
    }
    return msg('extra.cron.sPlainAt', { time: clocks });
  }
  const time = clockList(plan, sh, msg, locale, h12) ?? descriptive;
  if (restrictedDom && restrictedDow) {
    return msg('extra.cron.sUnion', {
      a: domClause(plan, sh, msg, locale),
      b: uiLocale === 'en' ? lowerFirst(dowClause(plan, sh, msg, locale)) : dowClause(plan, sh, msg, locale),
      time,
    });
  }
  const when = restrictedDom
    ? domClause(plan, sh, msg, locale)
    : restrictedDow
      ? dowClause(plan, sh, msg, locale)
      : msg('extra.cron.wMonths', {
          mp: msg('extra.cron.mpOf', { months: monthNames(sh.month.values, msg, locale) }),
          me: monthNames(sh.month.values, msg, locale),
        });
  return msg('extra.cron.sWhen', { when, time });
}

function dayFieldText(field: CronDayField, values: number[], msg: Msg, locale: LocaleCode): string {
  if (field.special) return msg('extra.cron.rawGloss', { raw: field.raw, gloss: specialGloss(field.special, msg) });
  if (field.all) return msg('extra.cron.fvAll', { count: formatNumber(values.length, locale) });
  return expandValues(values, msg, locale);
}

function fieldValuesRows(plan: CronPlan, sh: CronShapes, msg: Msg, locale: LocaleCode): Array<[string, string]> {
  const named = (values: number[], labels: string): string =>
    msg('extra.cron.fvValue', { values: listCompact(values, 8), names: labels });
  const dowRun = sh.dow.run
    ? msg('extra.cron.dowRun', { from: dowName(sh.dow.run.lo, msg, locale), to: dowName(sh.dow.run.hi, msg, locale) })
    : dowNames(sh.dow.values, msg, locale);
  return [
    [msg('extra.cron.fieldSecond'), expandValues(sh.second.values, msg, locale)],
    [msg('extra.cron.fieldMinute'), expandValues(sh.minute.values, msg, locale)],
    [msg('extra.cron.fieldHour'), expandValues(sh.hour.values, msg, locale)],
    [msg('extra.cron.fieldDay'), dayFieldText(plan.dom, sh.dom.values, msg, locale)],
    [msg('extra.cron.fieldMonth'), named(sh.month.values, monthNames(sh.month.values, msg, locale))],
    [
      msg('time.label.weekday'),
      plan.dow.special || plan.dow.all
        ? dayFieldText(plan.dow, sh.dow.values, msg, locale)
        : named(sh.dow.values, dowRun),
    ],
  ];
}

function countdownText(ms: number, msg: Msg, locale: LocaleCode): string {
  const abs = Math.max(0, Math.round(ms / SEC_MS));
  const days = Math.floor(abs / 86400);
  const hours = Math.floor((abs % 86400) / 3600);
  const minutes = Math.floor((abs % 3600) / 60);
  const seconds = abs % 60;
  if (!abs) return msg('extra.cron.countdownNow');
  return msg('extra.cron.countdownValue', {
    days: formatNumber(days, locale),
    hours: pad(hours, 2),
    minutes: pad(minutes, 2),
    seconds: pad(seconds, 2),
  });
}

interface CronShapes {
  second: FieldShape;
  minute: FieldShape;
  hour: FieldShape;
  month: FieldShape;
  dom: FieldShape;
  dow: FieldShape;
}

function shapesOf(plan: CronPlan): CronShapes {
  return {
    second: shapeOf(plan.second, 0, 59),
    minute: shapeOf(plan.minute, 0, 59),
    hour: shapeOf(plan.hour, 0, 23),
    month: shapeOf(plan.month, 1, 12),
    dom: shapeOf(plan.dom.values, 1, 31),
    dow: shapeOf(plan.dow.values, 0, 6),
  };
}


const cronTool: ToolImpl = {
  id: 'cron',
  async run(ctx): Promise<ToolResult> {
    const uiLocale = localeOf(ctx);
    const msg = makeMsg(uiLocale);
    const expression = optStr(ctx, 'expression');
    if (!expression) {
      throw new EngineError('bad_request', msg('extra.cron.errorEmpty', { example: CRON_EXAMPLE }));
    }
    const timeZone = assertTimeZone(optStr(ctx, 'timezone') || 'Asia/Shanghai', 'timezone', uiLocale);
    const now = nowOf(ctx);
    const locale = phraseLocale(uiLocale, optLocale(ctx));
    const want = Math.max(1, Math.min(50, Math.round(optNum(ctx, 'count', 5))));
    const showFieldValues = optBool(ctx, 'showFieldValues', true);
    const showCountdown = optBool(ctx, 'showCountdown', true);
    const macroKey = expression.trim().toLowerCase();
    const macro = CRON_MACROS[macroKey] ?? '';
    if (macroKey === CRON_REBOOT) {
      const bootBlocks: string[] = [
        section(msg('extra.cron.title', { zone: timeZone })),
        alignRows([
          [msg('extra.cron.expression'), expression],
          [msg('extra.cron.fields'), msg('extra.cron.fieldsReboot')],
          [msg('extra.cron.sentenceLabel'), msg('extra.cron.rebootTitle')],
        ]),
        section(msg('common.section.notes')),
        [msg('extra.cron.rebootNote'), msg('extra.cron.noteDow')].join('\n'),
      ];
      await emitText(ctx, 'cron.txt', joinBlocks(bootBlocks));
      ctx.report({ percent: 100, phase: 'done' });
      return {
        extra: {
          expression,
          timezone: timeZone,
          fields: '0',
          from: formatInZone(timeZone, now, uiLocale),
          count: '0',
          first: '',
          last: '',
          sentence: msg('extra.cron.rebootTitle'),
        },
      };
    }
    const canonical = macro || expression;
    const plan = parseCron(msg, canonical);
    const sh = shapesOf(plan);
    const sentence = cronSentence(plan, sh, msg, locale, uiLocale);
    const fromRaw = optStr(ctx, 'from') || 'now';
    const from = parseFlexPrecise(fromRaw, { timeZone, field: 'from', fallbackNow: now }, uiLocale);
    const fromParts = zonedParts(timeZone, from.epochMs, uiLocale);
    const { runs, skipped } = findRuns(timeZone, from.epochMs, plan, want, uiLocale);
    if (!runs.length) {
      throw new EngineError(
        'bad_request',
        msg('extra.cron.errorNever', { expression, at: formatInZone(timeZone, from.epochMs, uiLocale), example: CRON_EXAMPLE }),
      );
    }

    ctx.report({ percent: 70, phase: 'render' });

    const offsets = new Set(runs.map((run) => zonedParts(timeZone, run.epochMs, uiLocale).offsetMinutes));
    const rows = runs.map((run, position) => {
      const parts = zonedParts(timeZone, run.epochMs, uiLocale);
      return [
        `#${position + 1}`,
        msg('extra.cron.runValue', {
          wall: run.wall,
          weekday: weekdayLong(parts.weekday, locale),
          offset: offsetLabel(parts.offsetMinutes),
          abbrev: parts.abbrev,
          dst: parts.dst ? msg('time.instant.dstOn') : '',
        }),
      ] as [string, string];
    });
    const gaps: string[] = [];
    for (let i = 1; i < runs.length; i += 1) {
      gaps.push(decimalTrim(((runs[i] ?? runs[i - 1] ?? { epochMs: 0 }).epochMs - (runs[i - 1] ?? { epochMs: 0 }).epochMs) / SEC_MS, 3));
    }
    const nextRun = runs[0] ?? { epochMs: 0, wall: '', skipped: null };
    const domRestricted = plan.dom.special !== null || !plan.dom.all;
    const dowRestricted = plan.dow.special !== null || !plan.dow.all;

    const blocks: string[] = [
      section(msg('extra.cron.title', { zone: timeZone })),
      alignRows([
        [msg('extra.cron.expression'), expression],
        [
          msg('extra.cron.fields'),
          macro
            ? msg('extra.cron.fieldsMacro', {
              macro: expression.trim(),
              canonical: macro,
              fields: plan.hasSeconds ? msg('extra.cron.fieldsSix') : msg('extra.cron.fieldsFive'),
            })
            : plan.hasSeconds ? msg('extra.cron.fieldsSix') : msg('extra.cron.fieldsFive'),
        ],
        [
          msg('extra.workdays.start'),
          resolutionDiffers(fromRaw, formatZoneStamp(timeZone, from.epochMs, uiLocale))
            ? msg('extra.cron.startValue', { raw: fromRaw, stamp: formatZoneStamp(timeZone, from.epochMs, uiLocale), weekday: weekdayLong(fromParts.weekday, locale) })
            : msg('extra.cron.startValueDirect', { stamp: formatZoneStamp(timeZone, from.epochMs, uiLocale), weekday: weekdayLong(fromParts.weekday, locale) }),
        ],
        [msg('extra.cron.planned'), formatNumber(want, locale)],
        [msg('extra.cron.hits'), msg('extra.cron.hitsValue', { count: formatNumber(runs.length, locale) })],
      ]),
      section(msg('extra.cron.scheduleSection')),
      alignRows(
        macro
          ? [[msg('extra.cron.macroLabel'), msg('extra.cron.macroValue', { macro: expression.trim(), canonical: macro, sentence })]]
          : [[msg('extra.cron.sentenceLabel'), sentence]],
      ),
    ];
    if (showCountdown) {
      blocks.push(
        section(msg('extra.cron.nextSection')),
        alignRows([
          [msg('extra.cron.nextLabel'), msg('extra.cron.nextAtValue', { wall: nextRun.wall, zone: timeZone })],
          [msg('extra.cron.countdownLabel'), countdownText(nextRun.epochMs - from.epochMs, msg, locale)],
        ]),
      );
    }
    blocks.push(
      section(msg('extra.cron.normalized')),
      alignRows([
        [msg('extra.cron.fieldSecond'), msg('extra.cron.secondValue', { values: describeValues(plan.second, 0, 59), note: plan.hasSeconds ? msg('extra.cron.fromExpression') : msg('extra.cron.fixedZero') })],
        [msg('extra.cron.fieldMinute'), describeValues(plan.minute, 0, 59)],
        [msg('extra.cron.fieldHour'), describeValues(plan.hour, 0, 23)],
        [msg('extra.cron.fieldDay'), plan.dom.special ? msg('extra.cron.rawGloss', { raw: plan.dom.raw, gloss: specialGloss(plan.dom.special, msg) }) : plan.dom.all ? '*' : describeValues(plan.dom.values, 1, 31)],
        [msg('extra.cron.fieldMonth'), describeValues(plan.month, 1, 12)],
        [
          msg('time.label.weekday'),
          plan.dow.special
            ? msg('extra.cron.rawGloss', { raw: plan.dow.raw, gloss: specialGloss(plan.dow.special, msg) })
            : plan.dow.all
              ? '*'
              : msg('extra.cron.dowValue', {
                  values: describeValues(plan.dow.values, 0, 6),
                  list: [...plan.dow.values].sort((a, b) => a - b).map((d) => weekdayShort(d, msg)).join(msg('common.list.sep')),
                }),
        ],
      ]),
    );
    if (showFieldValues) {
      blocks.push(section(msg('extra.cron.fvSection')), alignRows(fieldValuesRows(plan, sh, msg, locale)));
    }
    blocks.push(
      section(msg('extra.cron.runs')),
      alignRows(rows, 2, 3),
      section(msg('extra.cron.gapSection')),
      alignRows([[msg('extra.cron.gaps'), gaps.length ? gaps.join(' · ') : msg('extra.cron.gapsSingle')]]),
    );

    const notes: string[] = [msg('extra.cron.noteDow')];
    if (!plan.hasSeconds) notes.push(msg('extra.cron.noteSeconds'));
    if (domRestricted && dowRestricted) {
      notes.push(msg('extra.cron.noteUnion'));
    }
    if (offsets.size > 1) {
      notes.push(
        msg('extra.cron.noteOffsets', {
          zone: timeZone,
          from: offsetLabel(Math.min(...offsets)),
          to: offsetLabel(Math.max(...offsets)),
        }),
      );
    }
    if (skipped.length) {
      notes.push(msg('extra.cron.noteSkipped', { list: skipped.join(msg('common.list.sep')) }));
    }
    blocks.push(section(msg('common.section.notes')), notes.join('\n'));

    await emitText(ctx, 'cron.txt', joinBlocks(blocks));
    ctx.report({ percent: 100, phase: 'done' });
    return {
      extra: {
        expression,
        timezone: timeZone,
        fields: String(plan.hasSeconds ? 6 : 5),
        from: formatInZone(timeZone, from.epochMs, uiLocale),
        count: String(runs.length),
        first: runs[0]?.wall ?? '',
        last: runs[runs.length - 1]?.wall ?? '',
        sentence,
      },
    };
  },
};

/* ── date-format ──────────────────────────────────────────────────────────── */

// Maximal run of one repeated character, so YYYY / MM / DD parse even when concatenated.
const TOKEN_RUN = /^(.)\1*/;

const PATTERN_TOKENS = ['YYYY', 'MM', 'DD', 'HH', 'mm', 'ss', 'SSS', 'ddd', 'dddd', 'A', 'ZZ'] as const;
type PatternToken = (typeof PATTERN_TOKENS)[number];

function classifyRun(run: string): PatternToken | null {
  return (PATTERN_TOKENS as readonly string[]).includes(run) ? (run as PatternToken) : null;
}

function localeIsChinese(locale: string): boolean {
  return locale.toLowerCase().startsWith('zh');
}

function weekdayName(weekday: number, locale: string, style: 'short' | 'long', msg: Msg): string {
  try {
    // 1970-01-04 is a Sunday, so the offset lands on the requested weekday in UTC.
    const probe = new Date(Date.UTC(1970, 0, 4 + (((weekday % 7) + 7) % 7)));
    const found = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', weekday: style })
      .formatToParts(probe)
      .find((part) => part.type === 'weekday');
    if (found?.value) return found.value;
  } catch {
    /* unknown locale falls through to the built-in tables */
  }
  return style === 'long'
    ? (WEEKDAYS_ZH[weekday] ?? '')
    : (localeIsChinese(locale) ? ZH_MSG(`time.dow.${weekday}`) : (WEEKDAYS_EN_SHORT[weekday] ?? ''));
}

function dayPeriod(parts: ZonedParts, locale: string): string {
  const pm = parts.hour >= 12;
  const lower = locale.toLowerCase();
  if (lower.startsWith('zh')) return pm ? ZH_MSG('extra.format.pm') : ZH_MSG('extra.format.am');
  if (lower.startsWith('ja')) return pm ? ZH_MSG('extra.format.pmJa') : ZH_MSG('extra.format.amJa');
  return pm ? 'PM' : 'AM';
}

function tokenValue(token: PatternToken, parts: ZonedParts, locale: string, msg: Msg): string {
  switch (token) {
    case 'YYYY':
      return pad(parts.year, 4);
    case 'MM':
      return pad(parts.month, 2);
    case 'DD':
      return pad(parts.day, 2);
    case 'HH':
      return pad(parts.hour, 2);
    case 'mm':
      return pad(parts.minute, 2);
    case 'ss':
      return pad(parts.second, 2);
    case 'SSS':
      return pad(parts.millisecond, 3);
    case 'ZZ':
      return offsetLabel(parts.offsetMinutes, false);
    case 'A':
      return dayPeriod(parts, locale);
    case 'ddd':
      return weekdayName(parts.weekday, locale, 'short', msg);
    case 'dddd':
      return weekdayName(parts.weekday, locale, 'long', msg);
  }
}

function renderPattern(pattern: string, parts: ZonedParts, locale: string, msg: Msg): string {
  let rest = pattern;
  let out = '';
  while (rest.length) {
    const run = TOKEN_RUN.exec(rest)?.[0];
    if (!run) {
      out += rest.charAt(0);
      rest = rest.slice(1);
      continue;
    }
    const token = classifyRun(run);
    out += token ? tokenValue(token, parts, locale, msg) : run;
    rest = rest.slice(run.length);
  }
  return out;
}

function usedTokens(pattern: string, msg: Msg): string {
  const unique = new Set<PatternToken>();
  let rest = pattern;
  while (rest.length) {
    const run = TOKEN_RUN.exec(rest)?.[0];
    if (!run) {
      rest = rest.slice(1);
      continue;
    }
    const token = classifyRun(run);
    if (token) unique.add(token);
    rest = rest.slice(run.length);
  }
  return unique.size ? [...unique].join(' · ') : msg('extra.format.noTokens');
}

function hour12(hour: number): number {
  const value = hour % 12;
  return value === 0 ? 12 : value;
}

const dateFormatTool: ToolImpl = {
  id: 'date-format',
  async run(ctx): Promise<ToolResult> {
    const uiLocale = localeOf(ctx);
    const msg = makeMsg(uiLocale);
    const timeZone = assertTimeZone(optStr(ctx, 'timezone') || 'Asia/Shanghai', 'timezone', uiLocale);
    const requested = optStr(ctx, 'locale') || 'zh-CN';
    const locale = uiLocale === 'en' && requested === 'zh-CN' ? 'en-US' : requested;
    const now = nowOf(ctx);
    const pattern = optStr(ctx, 'pattern');
    if (!pattern) {
      throw new EngineError('bad_request', msg('extra.format.errorPattern'));
    }
    const lines = splitLines(optStr(ctx, 'input'));
    if (!lines.length) {
      throw new EngineError('bad_request', msg('extra.format.errorInput'));
    }
    const showCommon = optBool(ctx, 'showCommon', true);
    const showEpochs = optBool(ctx, 'showEpochs', true);
    const phrase = phraseLocale(uiLocale, optLocale(ctx));

    const blocks: string[] = [
      section(msg('extra.format.title', { locale, zone: timeZone })),
      alignRows([
        [msg('extra.format.pattern'), pattern],
        [msg('extra.format.tokens'), usedTokens(pattern, msg)],
        [msg('time.label.timezone'), `${timeZone} · ${formatZoneStamp(timeZone, now, uiLocale)}`],
        [msg('extra.format.count'), formatNumber(lines.length, phrase)],
      ]),
    ];

    let firstParts: ZonedParts | null = null;
    let firstMs = now;
    const rendered: string[] = [];
    lines.forEach((line, position) => {
      const instant = parseFlexPrecise(line, { timeZone, field: 'input', fallbackNow: now }, uiLocale);
      const parts = zonedParts(timeZone, instant.epochMs, uiLocale);
      if (!firstParts) {
        firstParts = parts;
        firstMs = instant.epochMs;
      }
      const text = renderPattern(pattern, parts, locale, msg);
      rendered.push(text);
      blocks.push(
        section(`#${position + 1} ${line}`),
        alignRows([
          [msg('common.label.output'), text],
          [msg('time.label.localTime'), formatInZone(timeZone, instant.epochMs, uiLocale)],
          ['ISO 8601', isoInZone(timeZone, instant.epochMs, true, uiLocale)],
          [msg('time.label.weekday'), msg('extra.format.weekdayValue', { long: weekdayName(parts.weekday, locale, 'long', msg), short: weekdayShort(parts.weekday, msg) })],
          [msg('time.label.offset'), msg('extra.format.offsetValue', { offset: offsetLabel(parts.offsetMinutes), abbrev: parts.abbrev, state: parts.dst ? msg('time.instant.dstOn') : msg('time.instant.dstOff') })],
          ...(showEpochs
            ? ([
                [msg('basic.timestamp.unixSec'), String(Math.floor(instant.epochMs / SEC_MS))],
                [msg('extra.format.epochMs'), String(instant.epochMs)],
                [msg('extra.format.epochUs'), String(instant.epochUs)],
                [msg('extra.format.epochNs'), String(instant.epochNs)],
              ] as Array<[string, string]>)
            : []),
        ]),
      );
      ctx.report({ percent: Math.min(85, Math.round(((position + 1) / lines.length) * 85)), phase: 'render' });
    });

    const sample = firstParts ?? zonedParts(timeZone, firstMs, uiLocale);
    if (showCommon) {
      blocks.push(
        section(msg('extra.format.commonTitle')),
        alignRows([
          ['ISO 8601', isoInZone(timeZone, firstMs, true, uiLocale)],
          [msg('extra.format.isoDate'), renderPattern('YYYY-MM-DD', sample, locale, msg)],
          [msg('extra.format.dateTime'), renderPattern('YYYY-MM-DD HH:mm:ss', sample, locale, msg)],
          [msg('extra.format.toMinute'), renderPattern('YYYY-MM-DD HH:mm', sample, locale, msg)],
          [msg('extra.format.withWeekday'), renderPattern('YYYY-MM-DD dddd', sample, locale, msg)],
          [msg('extra.format.hour12'), `${pad(sample.year, 4)}-${pad(sample.month, 2)}-${pad(sample.day, 2)} ${hour12(sample.hour)}:${pad(sample.minute, 2)}:${pad(sample.second, 2)} ${dayPeriod(sample, locale)}`],
          [msg('extra.format.withOffset'), renderPattern('YYYY-MM-DD HH:mm:ss ZZ', sample, locale, msg)],
          ['RFC 2822', rfc2822(firstMs, timeZone, uiLocale)],
          [msg('extra.format.fileSafe'), renderPattern('YYYYMMDD-HHmmss', sample, locale, msg)],
          [msg('time.label.longDate'), longDate(firstMs, timeZone, uiLocale)],
          [msg('extra.format.nativeStyle'), uiLocale === 'en'
            ? new Intl.DateTimeFormat(locale, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone }).format(new Date(firstMs))
            : renderPattern(msg('extra.format.nativePattern'), sample, locale, msg)],
          [msg('extra.format.usStyle'), renderPattern('MM/DD/YYYY HH:mm', sample, locale, msg)],
          [msg('extra.format.euStyle'), renderPattern('DD.MM.YYYY HH:mm', sample, locale, msg)],
          [msg('basic.timestamp.isoWeek'), `${sample.isoYear}-W${pad(sample.isoWeek, 2)}-${sample.isoWeekday}`],
          ['Unix', msg('time.value.secondsMs', { seconds: Math.floor(firstMs / SEC_MS), milliseconds: firstMs })],
        ]),
      );
      blocks.push(
        section(msg('extra.format.tokensTitle')),
        alignRows(PATTERN_TOKENS.map((token) => [token, tokenValue(token, sample, locale, msg)])),
      );
      blocks.push(
        section(msg('common.section.notes')),
        [
          msg('extra.format.noteTokens'),
          msg('extra.format.noteLocale', { locale, period: dayPeriod(sample, locale) }),
          ...(showEpochs ? [msg('extra.format.epochNote')] : []),
        ].join('\n'),
      );
    }

    await emitText(ctx, 'date-format.txt', joinBlocks(blocks));
    ctx.report({ percent: 100, phase: 'done' });
    return {
      extra: {
        inputs: lines.length,
        locale,
        timezone: timeZone,
        pattern,
        showCommon: String(showCommon),
        rendered: rendered[0] ?? '',
      },
    };
  },
};

export const timeExtraTools: ToolImpl[] = [
  workdaysTool,
  timezoneBoardTool,
  durationTool,
  cronTool,
  dateFormatTool,
];
