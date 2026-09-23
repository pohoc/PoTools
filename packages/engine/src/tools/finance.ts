import type { ToolImpl } from '../types.ts';
import { makeMsg, localeOf } from '../lib/messages.ts';
import { emitText, optSelect, optStr } from './time-core.ts';
import { EngineError } from '../errors.ts';

const DIGITS = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖'];
const SMALL_UNITS = ['', '拾', '佰', '仟'];
const LARGE_UNITS = ['', '万', '亿', '兆'];
const DIGIT_VALUES: Record<string, number> = {
  零: 0, 〇: 0, 壹: 1, 一: 1, 贰: 2, 弍: 2, 二: 2, 叁: 3, 參: 3, 三: 3,
  肆: 4, 四: 4, 伍: 5, 五: 5, 陆: 6, 陸: 6, 六: 6, 柒: 7, 七: 7, 捌: 8, 八: 8, 玖: 9, 九: 9,
};
const UNIT_VALUES: Record<string, number> = {
  拾: 10, 十: 10, 佰: 100, 百: 100, 仟: 1000, 千: 1000,
};
const LARGE_VALUES: Record<string, number> = { 万: 10_000, 萬: 10_000, 亿: 100_000_000, 億: 100_000_000, 兆: 1_000_000_000_000 };

function groupToUppercase(value: number): string {
  const digits = String(value).padStart(4, '0');
  let result = '';
  let pendingZero = false;
  for (let index = 0; index < 4; index += 1) {
    const digit = Number(digits[index]);
    if (digit === 0) {
      if (result && digits.slice(index + 1).split('').some((item) => item !== '0')) pendingZero = true;
      continue;
    }
    if (pendingZero) result += DIGITS[0];
    result += DIGITS[digit]! + SMALL_UNITS[3 - index]!;
    pendingZero = false;
  }
  return result;
}

function integerToUppercase(input: string): string {
  const normalized = input.replace(/^0+(?=\d)/, '');
  if (normalized === '0') return DIGITS[0]!;
  if (normalized.length > 16) throw new Error('range');
  const groups: number[] = [];
  for (let end = normalized.length; end > 0; end -= 4) groups.push(Number(normalized.slice(Math.max(0, end - 4), end)));
  let result = '';
  let skipped = false;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index]!;
    if (group === 0) {
      if (result && groups.slice(0, index).some((item) => item > 0)) skipped = true;
      continue;
    }
    if (result && (skipped || group < 1000) && !result.endsWith(DIGITS[0]!)) result += DIGITS[0]!;
    result += groupToUppercase(group) + LARGE_UNITS[index]!;
    skipped = false;
  }
  return result;
}

function arabicToUppercase(input: string): string {
  const cleaned = input.trim().replace(/[¥￥,，\s]/g, '').replace(/^人民币/, '');
  const match = cleaned.match(/^([+-]?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) throw new Error('number');
  const [, sign, rawInteger, rawDecimal = ''] = match;
  const integer = rawInteger!.replace(/^0+(?=\d)/, '');
  if (integer.length > 16) throw new Error('range');
  const decimal = rawDecimal!.padEnd(2, '0');
  let result = integerToUppercase(integer) + '元';
  const jiao = Number(decimal[0] ?? '0');
  const fen = Number(decimal[1] ?? '0');
  if (!jiao && !fen) result += '整';
  else {
    if (jiao) result += DIGITS[jiao] + '角';
    if (fen) result += `${jiao ? '' : DIGITS[0]}${DIGITS[fen]}分`;
  }
  return `${sign === '-' ? '负' : ''}${result}`;
}

function parseChineseInteger(input: string): bigint {
  if (!input) return 0n;
  let total = 0n;
  let section = 0n;
  let digit = 0n;
  for (const character of input) {
    if (character in DIGIT_VALUES) {
      digit = BigInt(DIGIT_VALUES[character]!);
      continue;
    }
    if (character in UNIT_VALUES) {
      const unit = BigInt(UNIT_VALUES[character]!);
      if (digit === 0n && unit !== 10n) throw new Error('number');
      section += (digit || 1n) * unit;
      digit = 0n;
      continue;
    }
    if (character in LARGE_VALUES) {
      const unit = BigInt(LARGE_VALUES[character]!);
      section += digit;
      total += (section || 1n) * unit;
      section = 0n;
      digit = 0n;
      continue;
    }
    throw new Error('number');
  }
  return total + section + digit;
}

function uppercaseToArabic(input: string): string {
  const cleaned = input.trim().replace(/^人民币/, '').replace(/^[¥￥]/, '').replace(/\s/g, '');
  const sign = cleaned.startsWith('负') || cleaned.startsWith('-') ? '-' : '';
  const unsigned = cleaned.replace(/^(负|-|\+)/, '');
  const parts = unsigned.split(/[元圆圓]/);
  if (parts.length > 2) throw new Error('number');
  const integerText = parts[0]!.replace(/整$/, '');
  const integerValue = parseChineseInteger(integerText);
  if (integerValue > 999_999_999_999_999n) throw new Error('range');
  let jiao = 0, fen = 0;
  const decimalText = parts[1] ?? '';
  const decimalPattern = /^(?:([零〇壹一贰弍二叁參三肆四伍五陆陸六柒七捌八玖九])角)?(?:([零〇壹一贰弍二叁參三肆四伍五陆陸六柒七捌八玖九])分)?(?:整)?$/;
  const decimalMatch = decimalText.match(decimalPattern);
  if (!decimalMatch || (!integerText && !decimalText)) throw new Error('number');
  if (decimalMatch[1]) jiao = DIGIT_VALUES[decimalMatch[1]]!;
  if (decimalMatch[2]) fen = DIGIT_VALUES[decimalMatch[2]]!;
  const whole = integerValue.toString();
  return `${sign}${whole}.${jiao}${fen}`;
}

export const financeTools: ToolImpl[] = [{
  id: 'amount-convert',
  async run(ctx) {
    const msg = makeMsg(localeOf(ctx));
    const input = optStr(ctx, 'input').trim();
    if (!input) throw new EngineError('bad_request', msg('finance.error.empty'));
    const direction = optSelect(ctx, 'direction', ['to-uppercase', 'to-number'] as const, 'to-uppercase');
    let output: string;
    try {
      output = direction === 'to-uppercase' ? arabicToUppercase(input) : uppercaseToArabic(input);
    } catch (error) {
      const code = error instanceof Error && error.message === 'range' ? 'finance.error.range' : 'finance.error.format';
      throw new EngineError('bad_request', msg(code));
    }
    const label = direction === 'to-uppercase' ? msg('finance.result.uppercase') : msg('finance.result.number');
    await emitText(ctx, 'amount-convert.txt', `${label}\n${output}`);
    ctx.report({ percent: 100, phase: 'done' });
    return { extra: { direction, output } };
  },
}];
