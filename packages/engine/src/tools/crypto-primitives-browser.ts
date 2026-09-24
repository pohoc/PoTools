import { assessPasswordStrength } from '@potools/core';
import { EngineError } from '../errors.ts';
import { localeOf, makeMsg } from '../lib/messages.ts';
import type { ToolContext, ToolImpl, ToolResult } from '../types.ts';
import { alignRows, emitText, joinBlocks, optBool, optNum, optSelect, optStr, parseFlex, phraseLocale, relativePhrase, section } from './time-core.ts';
import type { MsgLocale, Row } from './time-core.ts';

type Msg = ReturnType<typeof makeMsg>;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function rawOption(ctx: ToolContext, key: string): string {
  const value = ctx.options[key];
  if (value === undefined || value === null) return '';
  return String(value).replace(/\r\n/g, '\n').replace(/\s+$/, '');
}

function bad(msg: Msg, field: string, reason: string, example: string): EngineError {
  return new EngineError('bad_request', msg('common.error.badField', { field, reason, example }));
}

function need(msg: Msg, ctx: ToolContext, key: string, label: string, example: string): string {
  const raw = optStr(ctx, key);
  if (!raw) throw bad(msg, key, msg('sec.need.reason.1', { label }), example);
  return raw;
}

function secureRandomInt(min: number, max: number): number {
  const range = max - min;
  if (!Number.isInteger(range) || range < 1 || range > 0x10000) throw new RangeError('invalid random range');
  const limit = Math.floor(0x10000 / range) * range;
  const sample = new Uint16Array(1);
  do {
    globalThis.crypto.getRandomValues(sample);
  } while (sample[0]! >= limit);
  return min + (sample[0]! % range);
}

function secureRandomBytes(size: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(size));
}

function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/* ── password-gen ──────────────────────────────────────────────────────────── */

const CHAR_CLASSES = [
  { key: 'upper', label: 'sec.charClass.text.1', chars: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' },
  { key: 'lower', label: 'sec.charClass.text.2', chars: 'abcdefghijklmnopqrstuvwxyz' },
  { key: 'digits', label: 'sec.charClass.text.3', chars: '0123456789' },
  { key: 'symbols', label: 'sec.charClass.text.4', chars: '!@#$%^&*()-_=+[]{};:,.<>?/~' },
] as const;

function sampleFrom(chars: string): string {
  return chars.charAt(secureRandomInt(0, chars.length));
}

function shuffleChars(chars: string[]): string[] {
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = secureRandomInt(0, i + 1);
    const swap = chars[i]!;
    chars[i] = chars[j]!;
    chars[j] = swap;
  }
  return chars;
}

const passwordGenTool: ToolImpl = {
  id: 'password-gen',
  async run(ctx): Promise<ToolResult> {
    const msg = makeMsg(localeOf(ctx));
    const warnings: string[] = [];
    const length = clamp(Math.round(optNum(ctx, 'length', 20)), 4, 128);
    const count = clamp(Math.round(optNum(ctx, 'count', 5)), 1, 50);
    const ensureAll = optBool(ctx, 'ensureAll', true);
    const exclude = rawOption(ctx, 'exclude').replace(/\n/g, '');
    const excluded = new Set([...exclude]);
    const enabled = CHAR_CLASSES.filter((item) => optBool(ctx, item.key, true))
      .map((item) => ({ label: msg(item.label), chars: [...item.chars].filter((char) => !excluded.has(char)).join('') }))
      .filter((item) => item.chars.length > 0);
    if (!enabled.length) throw bad(msg, 'upper/lower/digits/symbols/exclude', msg('sec.password.reason.1'), msg('sec.password.reason.2'));
    const pool = shuffleChars([...new Set(enabled.map((item) => [...item.chars]).flat())]).join('');
    if (ensureAll && length < enabled.length) warnings.push(msg('sec.password.warn.1', { enabled: enabled.length, p1: length }));
    if (exclude) warnings.push(msg('sec.password.warn.2', { excluded: excluded.size, excluded2: [...excluded].join(' ') }));
    ctx.report({ percent: 30, phase: 'generate' });
    const passwords: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const mandatory = ensureAll && length >= enabled.length ? enabled.map((item) => sampleFrom(item.chars)) : [];
      const filler = Array.from({ length: length - mandatory.length }, () => sampleFrom(pool));
      const password = shuffleChars([...mandatory, ...filler]).join('');
      passwords.push(password);
      if ((index + 1) % 10 === 0) ctx.report({ percent: 30 + Math.round(((index + 1) / count) * 55), phase: 'generate' });
    }
    ctx.warnings.push(...warnings);
    await emitText(ctx, 'password-gen.txt', passwords.join('\n'));
    ctx.report({ percent: 100, phase: 'done' });
    return { extra: { count, length } };
  },
};

const passwordStrengthTool: ToolImpl = {
  id: 'password-strength',
  async run(ctx): Promise<ToolResult> {
    const password = optStr(ctx, 'password');
    if (!password) throw new EngineError('bad_request', makeMsg(localeOf(ctx))('sec.passwordStrength.empty'));
    const assessment = assessPasswordStrength(password);
    const msg = makeMsg(localeOf(ctx));
    const tips = assessment.tips.map((tip) => msg(`sec.passwordStrength.tip.${tip}`));
    await emitText(ctx, 'password-strength.txt', [
      `${msg('sec.passwordStrength.level')}: ${msg(`sec.passwordStrength.level.${assessment.level}`)}`,
      `${msg('sec.passwordStrength.length')}: ${assessment.length}`,
      tips.length ? `${msg('sec.passwordStrength.suggestions')}:\n- ${tips.join('\n- ')}` : msg('sec.passwordStrength.good'),
    ].join('\n'));
    return { extra: { level: assessment.level, score: assessment.score, length: assessment.length } };
  },
};

/* ── uuid-gen ──────────────────────────────────────────────────────────────── */

let v7State: { ms: number; seq: number } = { ms: -1, seq: 0 };

function uuidV7(): { bytes: Uint8Array; ms: number } {
  const now = Date.now();
  let ms = now;
  if (ms <= v7State.ms) {
    ms = v7State.ms;
    v7State = { ms, seq: v7State.seq + 1 };
    if (v7State.seq > 0x0fff) {
      ms = v7State.ms + 1;
      v7State = { ms, seq: 0 };
    }
  } else {
    v7State = { ms, seq: secureRandomInt(0, 0x0fff) };
  }
  const bytes = new Uint8Array(secureRandomBytes(16));
  bytes[0] = Math.floor(ms / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ms / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ms / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ms / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;
  bytes[6] = 0x70 | ((v7State.seq >>> 8) & 0x0f);
  bytes[7] = v7State.seq & 0xff;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return { bytes, ms };
}

function uuidFromBytes(bytes: Uint8Array): string {
  const hex = hexOf(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function applyUuidFormat(uuid: string, format: 'default' | 'braces' | 'urn' | 'upper', noHyphens: boolean): string {
  const body = noHyphens && format !== 'urn' ? uuid.replace(/-/g, '') : uuid;
  if (format === 'braces') return `{${body}}`;
  if (format === 'urn') return `urn:uuid:${body}`;
  if (format === 'upper') return body.toUpperCase();
  return body;
}

function timestampOf(uuid: string): number {
  return Number(BigInt(`0x${uuid.replace(/-/g, '').slice(0, 12)}`));
}

const uuidGenTool: ToolImpl = {
  id: 'uuid-gen',
  async run(ctx): Promise<ToolResult> {
    const msg = makeMsg(localeOf(ctx));
    const version = optSelect(ctx, 'version', ['v4', 'v7', 'nil'] as const, 'v4');
    const count = clamp(Math.round(optNum(ctx, 'count', 5)), 1, 100);
    const format = optSelect(ctx, 'format', ['default', 'braces', 'urn', 'upper'] as const, 'default');
    const noHyphens = optBool(ctx, 'noHyphens', false);
    const items: Array<{ raw: string; shown: string; note: string }> = [];
    for (let index = 0; index < count; index += 1) {
      if (version === 'nil') {
        items.push({ raw: NIL_UUID, shown: applyUuidFormat(NIL_UUID, format, noHyphens), note: msg('sec.uuid.note.1') });
        continue;
      }
      if (version === 'v7') {
        const made = uuidV7();
        const raw = uuidFromBytes(made.bytes);
        items.push({ raw, shown: applyUuidFormat(raw, format, noHyphens), note: `unix_ts=${made.ms}ms · ${new Date(made.ms).toISOString()}` });
        continue;
      }
      const raw = globalThis.crypto.randomUUID();
      items.push({ raw, shown: applyUuidFormat(raw, format, noHyphens), note: msg('sec.uuid.note.2') });
    }
    ctx.report({ percent: 80, phase: 'render' });
    const wellFormed = items.every((item) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item.raw));
    const versionBits = [...new Set(items.map((item) => item.raw[14]))];
    const variantBits = [...new Set(items.map((item) => item.raw[19]))];
    let strictlyIncreasing = true;
    for (let i = 1; i < items.length; i += 1) if (items[i - 1]!.raw >= items[i]!.raw) strictlyIncreasing = false;
    const blocks = [
      section(msg('sec.uuid.section.2', { version: version, count: count, format: format, section: noHyphens ? msg('sec.uuid.section.3') : '' })),
      items.map((item, index) => `${String(index + 1).padStart(3, ' ')}  ${item.shown}`).join('\n'),
      section(msg('sec.uuid.section.4')),
      alignRows([
        [msg('sec.uuid.row.1'), wellFormed ? msg('sec.uuid.row.2') : msg('sec.uuid.row.3')] as Row,
        [msg('sec.uuid.row.4'), versionBits.join('/')] as Row,
        [msg('sec.uuid.row.5'), variantBits.join('/')] as Row,
        [msg('sec.uuid.row.6'), msg('sec.uuid.row.7', { raw: new Set(items.map((item) => item.raw)).size, items: items.length })] as Row,
        ...(version === 'v7'
          ? [
              [msg('sec.uuid.row.8'), `${items[0]!.raw.replace(/-/g, '').slice(0, 12)} → ${new Date(timestampOf(items[0]!.raw)).toISOString()}`] as Row,
              [msg('sec.uuid.row.9'), strictlyIncreasing ? msg('sec.uuid.row.10', { items: items.length }) : msg('sec.uuid.row.11')] as Row,
            ] as Row[]
          : []),
      ]),
      ...(version === 'v7'
        ? [
            section(msg('sec.uuid.section.5')),
            alignRows(items.slice(0, 10).map((item, index) => [`#${index + 1}`, `${timestampOf(item.raw)} ms · sub-seq ${parseInt(item.raw.replace(/-/g, '').slice(12, 16), 16) & 0x0fff} · ${new Date(timestampOf(item.raw)).toISOString()}`] as Row)),
          ]
        : []),
      section(msg('common.section.notes')),
      [
        version === 'v4' ? msg('sec.uuid.row.12') : version === 'v7' ? msg('sec.uuid.row.13') : msg('sec.uuid.row.14'),
        msg('sec.uuid.row.15', { format: format, row: format === 'urn' ? msg('sec.uuid.row.16') : format === 'braces' ? msg('sec.uuid.row.17') : format === 'upper' ? msg('sec.uuid.row.18') : msg('sec.uuid.row.19') }),
        noHyphens ? msg('sec.uuid.row.20') : msg('sec.uuid.row.21'),
        msg('sec.uuid.row.22'),
      ].join('\n'),
    ];
    await emitText(ctx, 'uuid-gen.txt', joinBlocks(blocks));
    ctx.report({ percent: 100, phase: 'done' });
    return { extra: { version, count, format, noHyphens: noHyphens ? 'on' : 'off', first: items[0]!.shown, ordered: version === 'v7' ? (strictlyIncreasing ? 'yes' : 'no') : 'n/a' } };
  },
};


const TOTP_ALGOS = ['sha1', 'sha256', 'sha384', 'sha512'] as const;
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function localTime(uiLocale: MsgLocale, ms: number): string {
  return new Date(ms).toLocaleString(phraseLocale(uiLocale, 'zh-CN'), { hour12: false });
}

function agoText(uiLocale: MsgLocale, deltaMs: number): string {
  return relativePhrase(deltaMs, phraseLocale(uiLocale, 'zh-CN'));
}

async function groupedFingerprint(bytes: Uint8Array, algorithm: 'sha1' | 'sha256'): Promise<string> {
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest(algorithm.toUpperCase().replace('SHA', 'SHA-'), input.buffer));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('').replace(/(.{2})(?!$)/g, '$1:').toUpperCase();
}

/* ── TOTP ──────────────────────────────────────────────────────────────────── */

function decodeBase32(msg: Msg, raw: string): Uint8Array {
  const cleaned = raw.toUpperCase().replace(/[\s-_]/g, '').replace(/=+$/, '');
  if (!cleaned) throw bad(msg, 'secret', msg('sec.decodeBase32.reason.2'), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  if (!/^[A-Z2-7]+$/.test(cleaned)) throw bad(msg, 'secret', msg('sec.decodeBase32.reason.3', { split: [...new Set(cleaned.replace(/[A-Z2-7]/g, '').split(''))].join(' ') }), 'GEZDGNBVGY3TQOJQ…');
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of cleaned) {
    buffer = (buffer << 5) | B32_ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (bits >= 5) throw bad(msg, 'secret', msg('sec.decodeBase32.reason.4'), 'GEZDGNBVGY3TQOJQ…');
  if (!out.length) throw bad(msg, 'secret', msg('sec.decodeBase32.reason.1'), 'GEZDGNBVGY3TQOJQ…');
  return new Uint8Array(out);
}

function encodeBase32(bytes: Uint8Array): string {
  let buffer = 0;
  let bits = 0;
  let out = '';
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

function parseOtpauth(raw: string): { type: string; label: string; params: Record<string, string> } | null {
  if (!/^otpauth:\/\//i.test(raw.trim())) return null;
  const body = raw.trim().slice(raw.trim().indexOf('//') + 2);
  const cut = body.indexOf('?');
  const head = cut < 0 ? body : body.slice(0, cut);
  const query = cut < 0 ? '' : body.slice(cut + 1);
  const params: Record<string, string> = {};
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = (eq < 0 ? pair : pair.slice(0, eq)).trim().toLowerCase();
    const value = eq < 0 ? '' : pair.slice(eq + 1).trim();
    if (key) params[key] = decodeURIComponent(value.replace(/\+/g, ' '));
  }
  const [type, ...rest] = head.split('/');
  return { type: (type ?? 'totp').toLowerCase(), label: decodeURIComponent(rest.join('/')), params };
}

async function hotp(secretBytes: Uint8Array, counter: number, algorithm: string, digits: number): Promise<{ code: string; binary: number; digest: Uint8Array }> {
  const hash = algorithm.toUpperCase().replace('SHA', 'SHA-');
  const keyData = new Uint8Array(secretBytes.byteLength);
  keyData.set(secretBytes);
  const key = await globalThis.crypto.subtle.importKey('raw', keyData.buffer, { name: 'HMAC', hash }, false, ['sign']);
  const counterBytes = new Uint8Array(8);
  new DataView(counterBytes.buffer).setBigUint64(0, BigInt.asUintN(64, BigInt(counter)));
  const digest = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, counterBytes.buffer));
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = (((digest[offset]! & 0x7f) << 24) | ((digest[offset + 1]! & 0xff) << 16) | ((digest[offset + 2]! & 0xff) << 8) | (digest[offset + 3]! & 0xff)) >>> 0;
  return { code: String(binary % 10 ** digits).padStart(digits, '0'), binary, digest };
}

function resolveAt(msg: Msg, raw: string, uiLocale: MsgLocale): { ms: number; label: string } {
  const value = raw.trim();
  if (!value || value.toLowerCase() === 'now') return { ms: Date.now(), label: msg('sec.resolveAt.text.1') };
  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    const numeric = Number(value);
    const asMs = Math.abs(numeric) >= 1e11 ? numeric : numeric * 1000;
    return { ms: asMs, label: msg('sec.resolveAt.text.2', { value: value, text: Math.abs(numeric) >= 1e11 ? msg('sec.resolveAt.text.3') : msg('sec.resolveAt.text.4') }) };
  }
  try {
    return { ms: parseFlex(value, { unit: 'auto', field: 'at' }, uiLocale).getTime(), label: msg('sec.resolveAt.reason.1', { value: value }) };
  } catch (error) {
    throw bad(msg, 'at', msg('sec.resolveAt.reason.2', { value: value, message: (error as Error).message }), 'now / 59 / 1234567890 / 2026-01-01T00:00:00Z');
  }
}

export const embeddedTotpTool: ToolImpl = {
  id: 'totp',
  async run(ctx): Promise<ToolResult> {
    const uiLocale = localeOf(ctx);
    const msg = makeMsg(uiLocale);
    const rawSecret = need(msg, ctx, 'secret', msg('sec.totp.reason.1'), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    const mode = optSelect(ctx, 'mode', ['generate', 'verify'] as const, 'generate');
    const codeOption = optStr(ctx, 'code');
    const uri = parseOtpauth(rawSecret);
    let digits = clamp(Math.round(optNum(ctx, 'digits', 6)), 6, 10);
    let period = clamp(Math.round(optNum(ctx, 'period', 30)), 1, 3600);
    let algorithm: string = optSelect(ctx, 'algorithm', TOTP_ALGOS, 'sha1');
    const overrides: string[] = [];
    let secretText = rawSecret;
    if (uri) {
      const fromUri = uri.params.secret ?? uri.params['otpauth://secret'] ?? '';
      if (!fromUri) throw bad(msg, 'secret', msg('sec.totp.reason.2'), 'otpauth://totp/Alice:alice@example.com?secret=GEZDGNBVGY3TQOJQ&issuer=Alice&digits=8');
      secretText = fromUri;
      const uriDigits = Number.parseInt(uri.params.digits ?? '', 10);
      if (Number.isFinite(uriDigits) && uriDigits > 0) {
        digits = clamp(uriDigits, 6, 10);
        overrides.push(`digits=${digits}`);
      }
      const uriPeriod = Number.parseInt(uri.params.period ?? '', 10);
      if (Number.isFinite(uriPeriod) && uriPeriod > 0) {
        period = clamp(uriPeriod, 1, 3600);
        overrides.push(`period=${period}`);
      }
      const uriAlgorithm = (uri.params.algorithm ?? uri.params.algo ?? '').toLowerCase().replace(/-/g, '');
      if (uriAlgorithm && (TOTP_ALGOS as readonly string[]).includes(uriAlgorithm)) {
        algorithm = uriAlgorithm;
        overrides.push(`algorithm=${algorithm}`);
      }
      if (uri.params.issuer) overrides.push(`issuer=${uri.params.issuer}`);
      if (uri.label) overrides.push(`label=${uri.label}`);
      if (uri.type !== 'totp') overrides.push(msg('sec.totp.note.1', { type: uri.type }));
    }
    const secretBytes = decodeBase32(msg, secretText);
    const at = resolveAt(msg, optStr(ctx, 'at', 'now') || 'now', uiLocale);
    const window = clamp(Math.round(optNum(ctx, 'window', 1)), 0, 100);
    ctx.report({ percent: 40, phase: 'hmac' });
    const nowSeconds = Math.floor(at.ms / 1000);
    const counter = Math.floor(nowSeconds / period);
    const elapsed = nowSeconds % period;
    const remaining = period - elapsed;
    const current = await hotp(secretBytes, counter, algorithm, digits);

    if (mode === 'verify') {
      if (!codeOption) throw bad(msg, 'code', msg('sec.totp.reason.3'), current.code);
      const candidate = codeOption.replace(/[\s-_]/g, '');
      if (!/^\d+$/.test(candidate)) throw bad(msg, 'code', msg('sec.totp.reason.4', { candidate: candidate.slice(0, 12) }), '123456');
      const normalized = candidate.length === digits ? candidate : candidate.slice(-digits).padStart(digits, '0');
      const matched: Array<{ offset: number; step: number; code: string }> = [];
      const table: Row[] = [];
      for (let offset = -window; offset <= window; offset += 1) {
        const step = counter + offset;
        if (step < 0) {
          table.push([msg('sec.totp.row.3', { offset: offset < 0 ? offset : `+${offset}` }), msg('sec.totp.note.2') as string]);
          continue;
        }
        const computed = (await hotp(secretBytes, step, algorithm, digits)).code;
        const equal = computed === normalized;
        if (equal) matched.push({ offset, step, code: computed });
        table.push([msg('sec.totp.row.3', { offset: offset === 0 ? msg('sec.totp.row.4') : offset > 0 ? `+${offset}` : `${offset}` }), `${computed} · T=${step}${equal ? msg('sec.totp.note.3') : ''}`]);
      }
      ctx.report({ percent: 85, phase: 'compare' });
      const hit = matched[0];
      const blocks = [
        section(msg('sec.totp.section.1', { algorithm: algorithm.toUpperCase(), digits: digits, period: period })),
        alignRows([
          [msg('sec.totp.row.5'), normalized],
          [msg('sec.totp.row.6'), `${localTime(uiLocale, at.ms)} · ${at.label}`],
          [msg('sec.totp.row.7'), msg('sec.totp.row.8', { counter: counter, remaining: remaining })],
          [msg('sec.totp.row.9'), msg('sec.totp.row.10', { window: window, table: table.length })],
          [msg('common.label.result'), matched.length ? msg('sec.totp.row.11', { offset: hit!.offset > 0 ? `+${hit!.offset}` : hit!.offset, step: hit!.step }) : msg('sec.totp.section.2')],
        ]),
        section(msg('sec.totp.section.3')),
        alignRows(table),
        ...(matched.length
          ? [
              section(msg('sec.totp.section.4')),
              alignRows(
                matched.map((item) => [msg('sec.totp.row.3', { offset: item.offset > 0 ? `+${item.offset}` : item.offset }), msg('sec.totp.row.12', { step: item.step, code: item.code, period: localTime(uiLocale, item.step * period * 1000), period2: localTime(uiLocale, (item.step + 1) * period * 1000 - 1), row: item.step === counter ? msg('sec.totp.row.13') : item.step < counter ? msg('sec.totp.row.14', { now: agoText(uiLocale, item.step * period * 1000 - Date.now()) }) : msg('sec.totp.row.15') })] as Row),
              ),
            ]
          : []),
        section(msg('common.section.notes')),
        [
          msg('sec.totp.row.16', { algorithm: algorithm.toUpperCase(), digits: digits }),
          uri ? msg('sec.totp.row.17', { row: overrides.join(msg('common.list.sep')) || msg('sec.totp.row.18') }) : msg('sec.totp.row.19'),
          msg('sec.totp.row.20', { period: matched.length ? Math.abs(matched[0]!.offset) * period : 0 }),
          matched.length ? msg('sec.totp.row.21') : msg('sec.totp.row.22'),
        ].join('\n'),
      ];
      await emitText(ctx, 'totp.txt', joinBlocks(blocks));
      ctx.report({ percent: 100, phase: 'done' });
      return { extra: { mode, ok: matched.length ? 'yes' : 'no', matchedStep: matched.length ? String(matched[0]!.step) : 'none', offset: matched.length ? String(matched[0]!.offset) : 'none', digits, period, algorithm, counter } };
    }

    const blocks = [
      section(msg('sec.totp.section.5', { algorithm: algorithm.toUpperCase(), digits: digits, period: period })),
      alignRows([
        [msg('sec.totp.row.23'), current.code],
        [msg('sec.totp.row.24'), msg('sec.totp.row.25', { remaining: remaining, period: localTime(uiLocale, counter * period * 1000), period2: localTime(uiLocale, (counter + 1) * period * 1000 - 1) })],
        [msg('sec.totp.row.26'), (await hotp(secretBytes, counter + 1, algorithm, digits)).code],
        [msg('sec.totp.row.6'), `${localTime(uiLocale, at.ms)} · ${at.label}`],
        [msg('sec.totp.row.27'), `${counter} = floor(${nowSeconds} / ${period})`],
        [msg('common.label.secret'), msg('sec.totp.row.28', { secretBytes: encodeBase32(secretBytes), secretBytes2: secretBytes.length, g: (await groupedFingerprint(secretBytes, 'sha256')).replace(/:/g, '') })],
        [msg('sec.totp.row.29'), `binary=${current.binary} → mod ${10 ** digits} → ${current.code}`],
      ]),
      section(msg('sec.totp.section.6', { window: window })),
      alignRows(await Promise.all(
        Array.from({ length: 2 * window + 1 }, (_, index) => index - window).map(async (offset) => {
          const step = counter + offset;
          const value = step < 0 ? msg('sec.totp.row.30') : (await hotp(secretBytes, step, algorithm, digits)).code;
          return [msg('sec.totp.row.3', { offset: offset === 0 ? msg('sec.totp.row.4') : offset > 0 ? `+${offset}` : `${offset}` }), `${value} · T=${step}`] as Row;
        }),
      )),
      ...(digits === 8
        ? []
        : [
            section(msg('sec.totp.section.7')),
            alignRows([
              [msg('sec.totp.row.31'), (await hotp(secretBytes, counter, algorithm, 8)).code],
              [msg('sec.totp.row.32', { digits: digits }), msg('sec.totp.row.33', { digits: digits, digits2: (await hotp(secretBytes, counter, algorithm, 8)).code.slice(8 - digits) })],
            ]),
          ]),
      section(msg('common.section.notes')),
      [
        msg('sec.totp.row.34', { remaining: remaining }),
        msg('sec.totp.row.35'),
        uri ? msg('sec.totp.row.36', { row: overrides.join(msg('common.list.sep')) || msg('sec.totp.row.37') }) : msg('sec.totp.row.38'),
        msg('sec.totp.row.39', { GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ: encodeBase32(decodeBase32(msg, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')), code: (await hotp(decodeBase32(msg, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'), 1, 'sha1', 8)).code }),
      ].join('\n'),
    ];
    await emitText(ctx, 'totp.txt', joinBlocks(blocks));
    ctx.report({ percent: 100, phase: 'done' });
    return { extra: { mode, code: current.code, remaining, digits, period, algorithm, counter, secretBytes: secretBytes.length } };
  },
};

export const embeddedCryptoPrimitiveTools: ToolImpl[] = [passwordGenTool, passwordStrengthTool, uuidGenTool, embeddedTotpTool];
