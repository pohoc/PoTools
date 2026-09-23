import { createHash, createHmac, getHashes } from 'node:crypto';
import { EngineError } from '../errors.ts';
import { localeOf, makeMsg } from '../lib/messages.ts';
import type { ToolContext, ToolImpl } from '../types.ts';
import { alignRows, emitText, joinBlocks, optBool, optNum, optSelect, optStr, section } from './time-core.ts';
import type { Row } from './time-core.ts';

type Msg = ReturnType<typeof makeMsg>;

type HashName = 'md5' | 'sha1' | 'sha256' | 'sha384' | 'sha512' | 'blake2b512';
type DigestFormat = 'hex' | 'base64';

const HASH_ALGORITHMS: readonly HashName[] = ['md5', 'sha1', 'sha256', 'sha384', 'sha512', 'blake2b512'];
const FILE_ALGORITHMS: readonly HashName[] = ['md5', 'sha1', 'sha256', 'sha512'];
const HMAC_ALGORITHMS: readonly HashName[] = ['sha256', 'sha1', 'sha512', 'md5'];

const B64_STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B32_STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const B32_CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const BASE58_BTC = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_RIPPLE = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';
const BASE36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const BASE16 = '0123456789ABCDEF';

const RADIX_ALPHABETS = {
  base32: B32_STD,
  'base32-crockford': B32_CROCKFORD,
  'base58-btc': BASE58_BTC,
  'base58-ripple': BASE58_RIPPLE,
  base36: BASE36,
  base16: BASE16,
} as const;

type RadixName = keyof typeof RADIX_ALPHABETS;

const RADIX_LABEL: Record<RadixName, string> = {
  base32: 'enc.radix.label.base32',
  'base32-crockford': 'enc.radix.label.base32Crockford',
  'base58-btc': 'enc.radix.label.base58Btc',
  'base58-ripple': 'enc.radix.label.base58Ripple',
  base36: 'enc.radix.label.base36',
  base16: 'enc.radix.label.base16',
};

const INPUT_AS_LABEL = { text: 'enc.inputAs.text', hex: 'enc.inputAs.hex', base64: 'enc.inputAs.base64' } as const;

const SIMPLE_ESCAPES: Record<number, string> = { 8: '\\b', 9: '\\t', 10: '\\n', 12: '\\f', 13: '\\r' };
const REVERSE_ESCAPES: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', "'": "'", '\\': '\\', '/': '/' };

const NAMED_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
  '\u00a0': '&nbsp;',
  '\u00a1': '&excl;',
  '\u00a3': '&pound;',
  '\u00a5': '&yen;',
  '\u00a7': '&sect;',
  '\u00a9': '&copy;',
  '\u00ae': '&reg;',
  '\u00b0': '&deg;',
  '\u00b1': '&plusmn;',
  '\u00b7': '&middot;',
  '\u00d7': '&times;',
  '\u00f7': '&divide;',
  '\u2013': '&ndash;',
  '\u2014': '&mdash;',
  '\u2018': '&lsquo;',
  '\u2019': '&rsquo;',
  '\u201c': '&ldquo;',
  '\u201d': '&rdquo;',
  '\u2020': '&dagger;',
  '\u2022': '&bull;',
  '\u2026': '&hellip;',
  '\u2030': '&permil;',
  '\u20ac': '&euro;',
  '\u2122': '&trade;',
};

const NAMED_ENTITY_REVERSE = new Map(Object.entries(NAMED_ENTITIES).map(([char, entity]) => [entity, char] as const));

function bad(msg: Msg, field: string, reason: string, example: string): EngineError {
  return new EngineError('bad_request', msg('common.error.badField', { field, reason, example }));
}

function needText(msg: Msg, ctx: ToolContext, key: string, example: string): string {
  const raw = optStr(ctx, key);
  if (!raw) throw bad(msg, key, msg('enc.error.emptyContent'), example);
  return raw;
}

function textToBytes(text: string, charset: 'utf8' | 'latin1'): Uint8Array {
  return charset === 'latin1' ? new Uint8Array(Buffer.from(text, 'latin1')) : new TextEncoder().encode(text);
}

function utf8OrLossy(bytes: Uint8Array, charset: 'utf8' | 'latin1'): { text: string; lossy: boolean } {
  if (charset === 'latin1') return { text: Buffer.from(bytes).toString('latin1'), lossy: false };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), lossy: false };
  } catch {
    return { text: new TextDecoder('utf-8').decode(bytes), lossy: true };
  }
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function spacedHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(' ');
}

function decodeHex(msg: Msg, raw: string, field: string): Uint8Array {
  const compact = raw.replace(/\\x/gi, '').replace(/0x/gi, '').replace(/[\s:,._-]+/g, '');
  if (!compact) throw bad(msg, field, msg('enc.error.hexNoChars'), '48 65 6c 6c 6f');
  const offender = /[^0-9a-fA-F]/.exec(compact);
  if (offender) {
    const position = compact.indexOf(offender[0]) + 1;
    throw bad(msg, field, msg('enc.error.hexBadChar', { char: offender[0], position }), '48656c6c6f');
  }
  if (compact.length % 2) throw bad(msg, field, msg('enc.error.hexOddLength', { length: compact.length }), '48656c6c6f');
  const bytes = new Uint8Array(compact.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(compact.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function encodeBase64(bytes: Uint8Array, urlSafe = false): string {
  const table = urlSafe ? B64_URL : B64_STD;
  const chunks: string[] = [];
  for (let index = 0; index < bytes.length; index += 3) {
    const rest = bytes.length - index;
    const packed =
      ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
    chunks.push(
      table[(packed >>> 18) & 63]! +
        table[(packed >>> 12) & 63]! +
        (rest > 1 ? table[(packed >>> 6) & 63]! : '=') +
        (rest > 2 ? table[packed & 63]! : '='),
    );
  }
  return chunks.join('');
}

function decodeBase64(msg: Msg, raw: string, field: string): Uint8Array {
  const normalized = raw.replace(/=/g, '').replace(/_/g, '/').replace(/-/g, '+').replace(/[\s\u3000]+/g, '');
  if (!normalized) throw bad(msg, field, msg('enc.error.b64NoChars'), '5Lit5paH');
  if (normalized.length % 4 === 1) throw bad(msg, field, msg('enc.error.b64OddChars'), '5Lit5paH');
  const bytes: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const [index, char] of normalized.split('').entries()) {
    const value = B64_STD.indexOf(char);
    if (value < 0) {
      throw bad(msg, field, msg('enc.error.b64BadChar', { char, position: index + 1 }), '5Lit5paH');
    }
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >> bits) & 0xff);
    }
  }
  if (bits >= 6 || (bits > 0 && accumulator & ((1 << bits) - 1))) {
    throw bad(msg, field, msg('enc.error.b64TrailingBits'), '5Lit5paH');
  }
  return new Uint8Array(bytes);
}

function stripDataUri(raw: string): string {
  return raw.replace(/^data:[^,;]*;base64,/i, '');
}

function encodeBase32(bytes: Uint8Array, alphabet: string, padding: boolean): string {
  let output = '';
  let accumulator = 0;
  let bits = 0;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += alphabet[(accumulator >> bits) & 31]!;
    }
  }
  if (bits > 0) output += alphabet[(accumulator << (5 - bits)) & 31]!;
  return padding ? output + '='.repeat((8 - (output.length % 8)) % 8) : output;
}

function decodeBase32(msg: Msg, raw: string, alphabet: string, crockford: boolean, field: string): Uint8Array {
  const folding = new Map<string, string>([
    ['I', '1'],
    ['L', '1'],
    ['O', '0'],
  ]);
  const compact = raw
    .replace(/[\s-]+/g, '')
    .replace(/=+$/, '')
    .toUpperCase();
  if (!compact) throw bad(msg, field, msg('enc.error.b32NoChars'), 'MZXW6YTBOI======');
  const bytes: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const [index, source] of compact.split('').entries()) {
    let char = source;
    if (crockford) {
      if (source === 'U') {
        throw bad(msg, field, msg('enc.error.b32CrockfordU'), 'AGJQE455YXN73CRSDEKOT8B9GR');
      }
      char = folding.get(source) ?? source;
    }
    const value = alphabet.indexOf(char);
    if (value < 0) {
      throw bad(msg, field, msg('enc.error.b32BadChar', { table: crockford ? 'Crockford' : 'RFC 4648', char: source, position: index + 1 }), 'MZXW6YTBOI');
    }
    accumulator = (accumulator << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >> bits) & 0xff);
    }
  }
  if (bits >= 5 || (bits > 0 && accumulator & ((1 << bits) - 1))) {
    throw bad(msg, field, msg('enc.error.b32Truncated'), 'MZXW6YTB');
  }
  return new Uint8Array(bytes);
}

function bytesToBig(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

// Leading 0x00 bytes carry no value in a big-integer radix, so they are re-stated as alphabet[0] (base58 "1").
function encodeRadix(bytes: Uint8Array, alphabet: string): string {
  const radix = BigInt(alphabet.length);
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  let value = bytesToBig(bytes.subarray(zeros));
  const digits: string[] = [];
  while (value > 0n) {
    digits.unshift(alphabet[Number(value % radix)]!);
    value /= radix;
  }
  return alphabet[0]!.repeat(zeros) + digits.join('');
}

function radixIndex(alphabet: string, char: string, caseInsensitive: boolean): number {
  const exact = alphabet.indexOf(char);
  if (exact >= 0) return exact;
  if (!caseInsensitive) return -1;
  const folded = char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase();
  return alphabet.indexOf(folded);
}

function decodeRadix(msg: Msg, raw: string, alphabet: string, field: string): Uint8Array {
  const radix = BigInt(alphabet.length);
  const caseInsensitive = /^[0-9A-F]+$/.test(alphabet) || /^[0-9A-Z]+$/.test(alphabet);
  const compact = raw.replace(/\s+/g, '');
  if (!compact) throw bad(msg, field, msg('enc.error.radixNoChars'), msg('enc.frame.charsLike', { chars: alphabet.slice(0, 12) }));
  let zeros = 0;
  while (zeros < compact.length && radixIndex(alphabet, compact[zeros]!, caseInsensitive) === 0) zeros += 1;
  let value = 0n;
  for (const [offset, char] of compact.slice(zeros).split('').entries()) {
    const digit = radixIndex(alphabet, char, caseInsensitive);
    if (digit < 0) {
      throw bad(msg, field, msg('enc.error.radixBadChar', { char, position: offset + zeros + 1 }), msg('enc.frame.availableChars', { chars: alphabet }));
    }
    value = value * radix + BigInt(digit);
  }
  const tail: number[] = [];
  while (value > 0n) {
    tail.unshift(Number(value % 256n));
    value >>= 8n;
  }
  return new Uint8Array([...new Array<number>(zeros).fill(0), ...tail]);
}

function encode16(bytes: Uint8Array, alphabet: string): string {
  let out = '';
  for (const byte of bytes) {
    out += alphabet[byte >> 4]! + alphabet[byte & 15]!;
  }
  return out;
}

function wrapLines(text: string, width: number): string {
  const pattern = new RegExp(`.{1,${width}}`, 'g');
  return text.match(pattern)?.join('\n') ?? text;
}

function preview(msg: Msg, text: string, limit = 72): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  if (chars.length <= limit) return flat || msg('enc.preview.blank');
  return msg('enc.preview.truncated', { head: chars.slice(0, limit).join(''), count: chars.length });
}

function groupDigits(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function humanBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1048576).toFixed(2)} MB`;
}

function codePoints(text: string): number {
  return [...text].length;
}

function renderDigest(bytes: Uint8Array, format: DigestFormat): string {
  return format === 'hex' ? toHex(bytes) : encodeBase64(bytes, false);
}

function availableAlgorithms(): Set<string> {
  return new Set(getHashes().map((name) => name.toLowerCase()));
}

function pickAlgorithms(msg: Msg, requested: string, allowed: readonly HashName[], field: string, warnings: string[]): HashName[] {
  const supported = allowed.filter((name) => availableAlgorithms().has(name));
  if (requested === 'all') {
    if (!supported.length) throw bad(msg, field, msg('enc.error.noDigestAlgorithms'), 'md5');
    if (supported.length < allowed.length) {
      warnings.push(msg('enc.warn.missingAlgorithms', { names: allowed.filter((n) => !supported.includes(n)).join(msg('common.list.sep')) }));
    }
    return supported;
  }
  const lowered = requested.toLowerCase() as HashName;
  if (!allowed.includes(lowered)) {
    throw bad(msg, field, msg('enc.error.invalidAlgorithm', { value: requested, values: ['all', ...allowed].join(msg('common.list.sep')) }), 'all');
  }
  if (!availableAlgorithms().has(lowered)) {
    throw bad(msg, field, msg('enc.error.algorithmUnavailable', { value: requested, values: supported.join(msg('common.list.sep')) }), supported[0] ?? 'md5');
  }
  return [lowered];
}

function digestBytes(bytes: Uint8Array, algorithm: HashName): Uint8Array {
  return new Uint8Array(createHash(algorithm).update(bytes).digest());
}

function formatHex(raw: string, uppercase: boolean): string {
  return uppercase ? raw.toUpperCase() : raw.toLowerCase();
}

const hashTool: ToolImpl = {
  id: 'hash',
  async run(ctx) {
    const msg = makeMsg(localeOf(ctx));
    const warnings: string[] = [];
    const raw = needText(msg, ctx, 'input', 'abc');
    const inputAs = optSelect(ctx, 'inputAs', ['text', 'hex', 'base64'] as const, 'text');
    const algorithm = optStr(ctx, 'algorithm', 'all') || 'all';
    const uppercase = optBool(ctx, 'uppercase', false);
    const bytes = inputAs === 'hex' ? decodeHex(msg, raw, 'input') : inputAs === 'base64' ? decodeBase64(msg, raw, 'input') : textToBytes(raw, 'utf8');
    const names = pickAlgorithms(msg, algorithm, HASH_ALGORITHMS, 'algorithm', warnings);
    ctx.report({ percent: 45, phase: 'digest' });
    const digests = names.map((name) => ({ name, value: formatHex(renderDigest(digestBytes(bytes, name), 'hex'), uppercase) }));
    const blocks = [
      section(msg('enc.hash.section.results')),
      alignRows(digests.map((item) => [item.name, item.value] as Row)),
      section(msg('enc.hash.title', { detail: algorithm === 'all' ? msg('enc.hash.algoCount', { count: names.length }) : names[0] ?? '' })),
      alignRows([
        [msg('enc.hash.label.inputForm'), msg(INPUT_AS_LABEL[inputAs])],
        [msg('enc.label.inputBytes'), msg('enc.unit.bytes', { count: groupDigits(bytes.length) })],
        [msg('enc.label.inputPreview'), preview(msg, raw)],
        [msg('enc.label.caseOut'), uppercase ? msg('enc.value.upper') : msg('enc.value.lower')],
      ]),
    ];
    const notes = [msg('enc.hash.noteTrim')];
    if (inputAs !== 'text') notes.push(msg('enc.hash.noteInputAs', { inputAs: msg(INPUT_AS_LABEL[inputAs]), count: bytes.length }));
    if (bytes.length !== Buffer.byteLength(raw, 'utf8')) notes.push(msg('enc.hash.noteRawLength', { rawBytes: Buffer.byteLength(raw, 'utf8'), usedBytes: bytes.length }));
    blocks.push(section(msg('common.section.notes')), notes.join('\n'));
    await emitText(ctx, 'hash.txt', joinBlocks(blocks));
    ctx.report({ percent: 100, phase: 'done' });
    return { extra: { algorithms: names.length, algorithm: names.join(','), inputBytes: bytes.length, digest: digests[0]?.value ?? '' } };
  },
};

const hmacTool: ToolImpl = {
  id: 'hmac',
  async run(ctx) {
    const msg = makeMsg(localeOf(ctx));
    const warnings: string[] = [];
    const message = optStr(ctx, 'message');
    if (!message) throw bad(msg, 'message', msg('enc.hmac.error.emptyMessage'), 'what do ya want for nothing?');
    const secretRaw = ctx.options.secret === undefined ? '' : String(ctx.options.secret);
    if (!secretRaw) throw bad(msg, 'secret', msg('enc.hmac.error.emptySecret'), 'Jefe');
    const algorithm = optStr(ctx, 'algorithm', 'sha256') || 'sha256';
    const format = optSelect(ctx, 'format', ['hex', 'base64'] as const, 'hex');
    const uppercase = optBool(ctx, 'uppercase', false);
    const names = pickAlgorithms(msg, algorithm, HMAC_ALGORITHMS, 'algorithm', warnings);
    const keyBytes = textToBytes(secretRaw, 'utf8');
    const messageBytes = textToBytes(message, 'utf8');
    ctx.report({ percent: 40, phase: 'sign' });
    const signed = names.map((name) => {
      const mac = new Uint8Array(createHmac(name, keyBytes).update(messageBytes).digest());
      const hex = renderDigest(mac, 'hex');
      const b64 = renderDigest(mac, 'base64');
      return { name, primary: format === 'hex' ? formatHex(hex, uppercase) : uppercase ? b64.toUpperCase() : b64, alt: format === 'hex' ? b64 : formatHex(hex, uppercase) };
    });
    const altLabel = format === 'hex' ? 'base64' : 'hex';
    const blocks = [
      section(msg('enc.hmac.section.results')),
      alignRows(signed.map((item) => [item.name, item.primary] as Row)),
      section(msg('enc.hmac.section.equivalent', { alt: altLabel })),
      alignRows(signed.map((item) => [item.name, item.alt] as Row)),
      section(msg('enc.hmac.title', { algos: names.join(msg('common.list.sep')), format })),
      alignRows([
        [msg('common.label.secret'), msg('enc.hmac.secretMasked', { preview: '••••', count: codePoints(secretRaw) })],
        [msg('enc.hmac.label.secretBytes'), msg('enc.unit.bytes', { count: groupDigits(keyBytes.length) })],
        [msg('enc.hmac.label.message'), preview(msg, message)],
        [msg('enc.hmac.label.messageBytes'), msg('enc.unit.bytes', { count: groupDigits(messageBytes.length) })],
        [msg('enc.label.caseOut'), uppercase && format === 'hex' ? msg('enc.value.upper') : msg('enc.value.asIs')],
      ]),
    ];
    const notes = [msg('enc.hmac.noteStructure')];
    notes.push(msg('enc.hmac.noteMasked'));
    blocks.push(section(msg('common.section.notes')), notes.join('\n'));
    if (warnings.length) blocks.push(section(msg('enc.section.warning')), warnings.map((item) => msg('enc.bullet.item', { item })).join('\n'));
    await emitText(ctx, 'hmac.txt', joinBlocks(blocks));
    ctx.report({ percent: 100, phase: 'done' });
    return { extra: { algorithm: names.join(','), format, algorithms: names.length, signature: signed[0]?.primary ?? '' } };
  },
};

interface ExpectedDigest {
  algorithm: string | null;
  value: string;
}

function parseExpected(raw: string): ExpectedDigest[] {
  const out: ExpectedDigest[] = [];
  for (const line of raw.split(/[\r\n,;]+/)) {
    for (const token of line.trim().split(/\s+/)) {
      if (!token) continue;
      const tagged = /^(md5|sha1|sha256|sha384|sha512|blake2b512)[=:]([\s\S]+)$/i.exec(token);
      const value = (tagged ? tagged[2]! : token).trim();
      if (!/^[0-9a-fA-F]{16,}$/.test(value) && !/^[A-Za-z0-9+/]{8,}={0,2}$/.test(value)) continue;
      out.push({ algorithm: tagged ? tagged[1]!.toLowerCase() : null, value });
    }
  }
  return out;
}

function matchesExpected(expected: ExpectedDigest[], digest: Uint8Array, algorithm: HashName): boolean {
  const hex = toHex(digest);
  const b64 = encodeBase64(digest, false);
  return expected.some((item) => {
    if (item.algorithm && item.algorithm !== algorithm) return false;
    const normalized = item.value.replace(/\s+/g, '');
    return normalized.toLowerCase() === hex || normalized === b64;
  });
}

const fileChecksumTool: ToolImpl = {
  id: 'file-checksum',
  async run(ctx) {
    const msg = makeMsg(localeOf(ctx));
    const warnings: string[] = [];
    const algorithm = optStr(ctx, 'algorithm', 'all') || 'all';
    const format = optSelect(ctx, 'format', ['hex', 'base64'] as const, 'hex');
    const expectedRaw = optStr(ctx, 'expected');
    const names = pickAlgorithms(msg, algorithm, FILE_ALGORITHMS, 'algorithm', warnings);
    if (!ctx.inputs.length) throw new EngineError('empty_selection', msg('enc.checksum.error.emptySelection'), 'error.emptySelection');
    const expected = expectedRaw ? parseExpected(expectedRaw) : [];
    if (expectedRaw && !expected.length) {
      warnings.push(msg('enc.checksum.warnNoExpected'));
    }
    if (expected.length && ctx.inputs.length > 1) {
      warnings.push(msg('enc.checksum.warnExpectedCount', { count: expected.length }));
    }
    const blocks: string[] = [
      section(msg('enc.checksum.title', { algos: names.join(msg('common.list.sep')), format })),
      alignRows([
        [msg('enc.checksum.label.files'), ctx.inputs.length],
        [msg('enc.checksum.label.totalBytes'), msg('enc.unit.bytes', { count: groupDigits(ctx.inputs.reduce((sum, input) => sum + input.bytes.byteLength, 0)) })],
        [msg('enc.checksum.label.expected'), expected.length ? msg('enc.unit.items', { count: expected.length }) : msg('enc.value.notProvided')],
      ]),
    ];
    let mismatches = 0;
    let matched = 0;
    for (const [index, input] of ctx.inputs.entries()) {
      const bytes = input.bytes;
      const rows: Row[] = [];
      const verdicts: Row[] = [];
      for (const name of names) {
        const digest = digestBytes(bytes, name);
        rows.push([name, renderDigest(digest, format)]);
        if (expected.length) {
          const hit = matchesExpected(expected, digest, name);
          if (hit) matched += 1;
          else mismatches += 1;
          const shown = expected.find((item) => !item.algorithm || item.algorithm === name);
          verdicts.push([name, `${hit ? msg('enc.checksum.verdict.matched') : msg('enc.checksum.verdict.unmatched')}${shown ? msg('enc.checksum.verdict.expectedFor', { value: shown.value }) : msg('enc.checksum.verdict.noExpectedFor')}`]);
        }
      }
      blocks.push(
        section(msg('enc.checksum.fileTitle', { index: index + 1, name: input.name, bytes: groupDigits(bytes.byteLength), human: humanBytes(bytes.byteLength) })),
        alignRows(rows),
      );
      if (verdicts.length) blocks.push(section(msg('enc.checksum.verdictTitle', { index: index + 1 })), alignRows(verdicts));
      ctx.report({ percent: Math.round(((index + 1) / ctx.inputs.length) * 88), phase: 'hash' });
    }
    const notes = [msg('enc.checksum.noteSource')];
    if (expected.length) {
      notes.push(msg('enc.checksum.noteVerdict', { matched, mismatches }));
    }
    blocks.push(section(msg('common.section.notes')), notes.join('\n'));
    if (warnings.length) blocks.push(section(msg('enc.section.warning')), warnings.map((item) => msg('enc.bullet.item', { item })).join('\n'));
    await emitText(ctx, 'checksums.txt', joinBlocks(blocks));
    ctx.report({ percent: 100, phase: 'done' });
    if (mismatches) ctx.warnings.push(msg('enc.checksum.warnMismatched', { count: mismatches }));
    return {
      extra: {
        files: ctx.inputs.length,
        algorithms: names.length,
        algorithm: names.join(','),
        format,
        checkedBytes: ctx.inputs.reduce((sum, input) => sum + input.bytes.byteLength, 0),
        matched,
        mismatched: mismatches,
      },
    };
  },
};

const base64Tool: ToolImpl = {
  id: 'base64',
  async run(ctx) {
    const msg = makeMsg(localeOf(ctx));
    const raw = needText(msg, ctx, 'input', msg('enc.example.cjkGreeting'));
    const mode = optSelect(ctx, 'mode', ['encode', 'decode'] as const, 'encode');
    const variant = optSelect(ctx, 'variant', ['standard', 'urlsafe'] as const, 'standard');
    const charset = optSelect(ctx, 'charset', ['utf8', 'latin1'] as const, 'utf8');
    const wrap = Math.max(0, Math.trunc(optNum(ctx, 'lineWrap', 0)));
    const dataUri = optBool(ctx, 'dataUri', false);
    const mime = optStr(ctx, 'mime', 'text/plain') || 'text/plain';
    const urlSafe = variant === 'urlsafe';
    const blocks: string[] = [];
    const notes: string[] = [];
    let extra: Record<string, string | number> = { mode, variant };
    ctx.report({ percent: 40, phase: mode });
    if (mode === 'encode') {
      const bytes = textToBytes(raw, charset);
      if (!bytes.length) throw bad(msg, 'input', msg('enc.error.nothingToEncode'), msg('enc.example.cjkGreeting'));
      const encoded = encodeBase64(bytes, urlSafe);
      blocks.push(
        section(msg('enc.b64.encodeTitle', { table: urlSafe ? msg('enc.b64.table.urlSafe') : msg('enc.b64.table.standard') })),
        wrap > 0 ? wrapLines(encoded, wrap) : encoded,
      );
      if (dataUri) blocks.push(section('Data URI'), `data:${mime};base64,${encoded}`);
      const padding = (encoded.match(/=+$/) ?? [''])[0]!.length;
      blocks.push(
        section(msg('common.section.stats')),
        alignRows([
          [msg('enc.label.inputChars'), codePoints(raw)],
          [msg('enc.label.inputBytes'), msg('enc.unit.bytesCharset', { count: groupDigits(bytes.length), charset: charset === 'latin1' ? 'latin1' : 'UTF-8' })],
          [msg('enc.label.outputChars'), encoded.length],
          [msg('enc.b64.label.padding'), padding],
          [msg('enc.b64.label.outputLines'), wrap > 0 ? Math.ceil(encoded.length / wrap) : 1],
        ]),
      );
      notes.push(urlSafe ? msg('enc.b64.noteUrlSafe') : msg('enc.b64.noteStandard'));
      if (wrap > 0) notes.push(msg('enc.b64.noteWrap', { width: wrap }));
      if (dataUri) notes.push(msg('enc.b64.noteDataUri', { mime }));
      else notes.push(msg('enc.b64.noteNoDataUri'));
      extra = { ...extra, inputBytes: bytes.length, outputChars: encoded.length, mime: dataUri ? mime : '-' };
    } else {
      const body = stripDataUri(raw);
      const bytes = decodeBase64(msg, body, 'input');
      const { text, lossy } = utf8OrLossy(bytes, charset);
      const reEncoded = encodeBase64(bytes, urlSafe);
      const normalized = body.replace(/[\s]+/g, '').replace(/=+$/, '');
      const stable = reEncoded.replace(/=+$/, '') === normalized;
      blocks.push(section(msg('enc.b64.decodeTitle', { table: urlSafe ? msg('enc.b64.table.urlSafe') : msg('enc.b64.table.standard') })), text || msg('enc.value.decodedEmpty'));
      blocks.push(
        section(msg('common.section.stats')),
        alignRows([
          [msg('enc.label.inputChars'), codePoints(body)],
          [msg('enc.b64.label.decodedBytes'), msg('enc.unit.bytesCharset', { count: groupDigits(bytes.length), charset: humanBytes(bytes.length) })],
          [msg('enc.b64.label.decodedText'), msg('enc.unit.chars', { count: codePoints(text) })],
          ['HEX', preview(msg, spacedHex(bytes), 96)],
          ['HEX (compact)', preview(msg, toHex(bytes), 192)],
          [msg('enc.label.reencoded'), stable ? msg('common.value.yes') : msg('enc.b64.value.notCanonical', { value: reEncoded })],
        ]),
      );
      notes.push(msg('enc.b64.noteDecodeBoth'));
      if (lossy) {
        notes.push(msg('enc.b64.noteLossy'));
        ctx.warnings.push(msg('enc.b64.warnLossy'));
      }
      if (!stable) ctx.warnings.push(msg('enc.b64.warnReencode'));
      extra = { ...extra, decodedBytes: bytes.length, decodedChars: codePoints(text), roundTrip: stable ? 'ok' : 'differs' };
    }
    blocks.push(section(msg('common.section.notes')), notes.join('\n'));
    await emitText(ctx, 'base64.txt', joinBlocks(blocks));
    ctx.report({ percent: 100, phase: 'done' });
    return { extra };
  },
};

function radixEncode(bytes: Uint8Array, alphabet: RadixName): string {
  const table = RADIX_ALPHABETS[alphabet];
  if (alphabet === 'base32') return encodeBase32(bytes, table, true);
  if (alphabet === 'base32-crockford') return encodeBase32(bytes, table, false);
  if (alphabet === 'base16') return encode16(bytes, table);
  return encodeRadix(bytes, table);
}

function radixDecode(msg: Msg, raw: string, alphabet: RadixName): Uint8Array {
  const table = RADIX_ALPHABETS[alphabet];
  if (alphabet === 'base32') return decodeBase32(msg, raw, table, false, 'input');
  if (alphabet === 'base32-crockford') return decodeBase32(msg, raw, table, true, 'input');
  if (alphabet === 'base16') return decodeHex(msg, raw, 'input');
  return decodeRadix(msg, raw, table, 'input');
}

const radixTool: ToolImpl = {
  id: 'radix',
  async run(ctx) {
    const msg = makeMsg(localeOf(ctx));
    const raw = needText(msg, ctx, 'input', 'foobar');
    const mode = optSelect(ctx, 'mode', ['encode', 'decode'] as const, 'encode');
    const alphabet = optSelect(ctx, 'alphabet', Object.keys(RADIX_ALPHABETS) as RadixName[], 'base32');
    const label = msg(RADIX_LABEL[alphabet]);
    const blocks: string[] = [];
    const notes: string[] = [];
    let extra: Record<string, string | number> = { mode, alphabet };
    ctx.report({ percent: 40, phase: mode });
    if (mode === 'encode') {
      const bytes = textToBytes(raw, 'utf8');
      if (!bytes.length) throw bad(msg, 'input', msg('enc.error.nothingToEncode'), 'foobar');
      const encoded = radixEncode(bytes, alphabet);
      blocks.push(section(msg('enc.radix.encodeTitle', { label })), encoded);
      blocks.push(
        section(msg('common.section.stats')),
        alignRows([
          [msg('enc.label.inputChars'), codePoints(raw)],
          [msg('enc.label.inputBytes'), msg('enc.unit.bytesUtf8', { count: groupDigits(bytes.length) })],
          [msg('enc.label.outputChars'), encoded.length],
          [msg('enc.radix.label.alphabetLength'), RADIX_ALPHABETS[alphabet].length],
          [msg('enc.radix.label.byteHex'), preview(msg, spacedHex(bytes), 96)],
        ]),
      );
      notes.push(
        alphabet === 'base58-btc' || alphabet === 'base58-ripple'
          ? msg('enc.radix.noteBase58')
          : alphabet === 'base36'
            ? msg('enc.radix.noteBase36')
            : alphabet === 'base32-crockford'
              ? msg('enc.radix.noteCrockford')
              : alphabet === 'base16'
                ? msg('enc.radix.noteBase16')
                : msg('enc.radix.noteBase32'),
      );
      extra = { ...extra, inputBytes: bytes.length, outputChars: encoded.length };
    } else {
      const bytes = radixDecode(msg, raw, alphabet);
      if (!bytes.length) throw bad(msg, 'input', msg('enc.error.emptyAfterDecode'), msg('enc.frame.charsPlain', { chars: raw.slice(0, 8) }));
      const { text, lossy } = utf8OrLossy(bytes, 'utf8');
      const reEncoded = radixEncode(bytes, alphabet);
      const stable = reEncoded.toUpperCase() === raw.replace(/[\s-]+/g, '').toUpperCase();
      blocks.push(section(msg('enc.radix.decodeTitle', { label })), lossy ? msg('enc.value.lossyHex', { hex: spacedHex(bytes) }) : text || msg('enc.value.decodedEmpty'));
      blocks.push(
        section(msg('enc.radix.section.bytes')),
        alignRows([
          [msg('enc.label.byteCount'), msg('enc.unit.bytes', { count: groupDigits(bytes.length) })],
          ['HEX', preview(msg, spacedHex(bytes), 96)],
          [msg('enc.radix.label.bigIntValue'), bytesToBig(bytes).toString(10)],
          [msg('enc.radix.label.reencoded'), stable ? msg('common.value.yes') : msg('enc.radix.value.notCanonical', { value: reEncoded })],
        ]),
      );
      notes.push(msg('enc.radix.noteDecodeBytes'));
      notes.push(msg('enc.radix.noteBigInt'));
      if (lossy) ctx.warnings.push(msg('enc.radix.warnLossy'));
      if (!stable) ctx.warnings.push(msg('enc.radix.warnReencode'));
      extra = { ...extra, decodedBytes: bytes.length, stable: stable ? 'yes' : 'no' };
    }
    blocks.push(section(msg('common.section.notes')), notes.join('\n'));
    await emitText(ctx, 'radix.txt', joinBlocks(blocks));
    ctx.report({ percent: 100, phase: 'done' });
    return { extra };
  },
};

const HEX_SEPARATORS = { none: 'enc.hex.sep.none', space: 'enc.hex.sep.space', 'backslash-x': 'enc.hex.sep.backslashX', 'prefix-0x': 'enc.hex.sep.prefix0x' } as const;
type HexSeparator = keyof typeof HEX_SEPARATORS;

function applySeparator(hex: string, separator: HexSeparator): string {
  const pairs: string[] = [];
  for (let index = 0; index < hex.length; index += 2) pairs.push(hex.slice(index, index + 2));
  if (separator === 'none') return pairs.join('');
  if (separator === 'backslash-x') return pairs.map((pair) => `\\x${pair}`).join('');
  if (separator === 'prefix-0x') return pairs.map((pair) => `0x${pair}`).join(' ');
  return pairs.join(' ');
}

const hexTool: ToolImpl = {
  id: 'hex',
  async run(ctx) {
    const msg = makeMsg(localeOf(ctx));
    const raw = needText(msg, ctx, 'input', 'Hello');
    const mode = optSelect(ctx, 'mode', ['encode', 'decode'] as const, 'encode');
    const charset = optSelect(ctx, 'charset', ['utf8', 'latin1'] as const, 'utf8');
    const separator = optSelect(ctx, 'separator', Object.keys(HEX_SEPARATORS) as HexSeparator[], 'none');
    const uppercase = optBool(ctx, 'uppercase', false);
    const blocks: string[] = [];
    const notes: string[] = [];
    let extra: Record<string, string | number> = { mode, charset, separator };
    ctx.report({ percent: 35, phase: mode });
    if (mode === 'encode') {
      const bytes = textToBytes(raw, charset);
      if (!bytes.length) throw bad(msg, 'input', msg('enc.error.nothingToEncode'), 'Hello');
      const hex = formatHex(toHex(bytes), uppercase);
      blocks.push(section(msg('enc.hex.encodeTitle', { charset, separator: msg(HEX_SEPARATORS[separator]) })), applySeparator(hex, separator));
      blocks.push(
        section(msg('common.section.stats')),
        alignRows([
          [msg('enc.label.inputChars'), codePoints(raw)],
          [msg('enc.label.inputBytes'), msg('enc.unit.bytesCharset', { count: groupDigits(bytes.length), charset: charset === 'latin1' ? 'latin1' : 'UTF-8' })],
          [msg('enc.hex.label.digits'), hex.length],
          [msg('enc.hex.label.separator'), msg(HEX_SEPARATORS[separator])],
        ]),
      );
      notes.push(msg('enc.hex.noteSeparator', { separator }));
      notes.push(uppercase ? msg('enc.hex.noteUpper') : msg('enc.hex.noteLower'));
      extra = { ...extra, bytes: bytes.length, hexDigits: hex.length };
    } else {
      const bytes = decodeHex(msg, raw, 'input');
      const { text, lossy } = utf8OrLossy(bytes, charset);
      const hex = formatHex(toHex(bytes), uppercase);
      blocks.push(section(msg('enc.hex.decodeTitle', { charset })), lossy ? msg('enc.value.lossyHex', { hex: spacedHex(bytes) }) : text || msg('enc.value.decodedEmpty'));
      blocks.push(
        section(msg('common.section.stats')),
        alignRows([
          [msg('enc.label.byteCount'), msg('enc.unit.bytes', { count: groupDigits(bytes.length) })],
          [msg('enc.hex.label.contiguous'), preview(msg, hex, 96)],
          [msg('enc.hex.label.textChars'), codePoints(text)],
          [msg('enc.label.reencoded'), hex === formatHex(toHex(textToBytes(text, charset)), uppercase) ? msg('common.value.yes') : msg('common.value.no')],
        ]),
      );
      notes.push(msg('enc.hex.noteDecodeCharset'));
      if (lossy) ctx.warnings.push(msg('enc.hex.warnLossy'));
      extra = { ...extra, bytes: bytes.length, hexDigits: hex.length };
    }
    blocks.push(section(msg('common.section.notes')), notes.join('\n'));
    await emitText(ctx, 'hex.txt', joinBlocks(blocks));
    ctx.report({ percent: 100, phase: 'done' });
    return { extra };
  },
};

function percentEncode(text: string, component: boolean, form = false): string {
  const encoded = component ? encodeURIComponent(text) : encodeURI(text);
  return form ? encoded.replace(/%20/g, '+') : encoded;
}

function percentDecode(msg: Msg, text: string, component: boolean, field: string, form = false): string {
  try {
    return component ? decodeURIComponent(form ? text.replace(/\+/g, ' ') : text) : decodeURI(form ? text.replace(/\+/g, ' ') : text);
  } catch {
    throw bad(msg, field, msg('enc.url.error.badPercent'), '%E4%B8%AD%E6%96%87');
  }
}

interface QueryPair {
  key: string;
  value: string;
  rawKey: string;
  rawValue: string;
  hasValue: boolean;
}

function splitUrl(input: string): { base: string; query: string; fragment: string; hadFragment: boolean; hadQuery: boolean } {
  const hashAt = input.indexOf('#');
  const hadFragment = hashAt >= 0;
  const withoutFragment = hadFragment ? input.slice(0, hashAt) : input;
  const fragment = hadFragment ? input.slice(hashAt + 1) : '';
  const queryAt = withoutFragment.indexOf('?');
  if (queryAt < 0) return { base: withoutFragment, query: '', fragment, hadFragment, hadQuery: false };
  return { base: withoutFragment.slice(0, queryAt), query: withoutFragment.slice(queryAt + 1), fragment, hadFragment, hadQuery: true };
}

function inferQuery(input: string): string {
  return input.includes('=') && !input.includes('://') ? input : '';
}

function parsePairs(msg: Msg, query: string): QueryPair[] {
  const pairs: QueryPair[] = [];
  for (const token of query.split('&')) {
    if (!token) continue;
    const at = token.indexOf('=');
    const rawKey = at < 0 ? token : token.slice(0, at);
    const rawValue = at < 0 ? '' : token.slice(at + 1);
    pairs.push({
      key: percentDecode(msg, rawKey, true, msg('enc.url.field.queryKey'), true),
      value: percentDecode(msg, rawValue, true, msg('enc.url.field.queryValue'), true),
      rawKey,
      rawValue,
      hasValue: at >= 0,
    });
  }
  return pairs;
}

function buildValue(text: string, component: boolean): string {
  if (component) return encodeURIComponent(text);
  return encodeURI(text).replace(/&/g, '%26').replace(/=/g, '%3D').replace(/\+/g, '%2B').replace(/#/g, '%23');
}

const urlCodecTool: ToolImpl = {
  id: 'url-codec',
  async run(ctx) {
    const msg = makeMsg(localeOf(ctx));
    const raw = needText(msg, ctx, 'input', msg('enc.example.urlQuery'));
    const mode = optSelect(ctx, 'mode', ['encode', 'decode', 'parse', 'build'] as const, 'encode');
    const component = optBool(ctx, 'component', true);
    const form = optBool(ctx, 'form', false);
    const blocks: string[] = [];
    const notes: string[] = [];
    let extra: Record<string, string | number> = { mode, component: component ? 'component' : 'url' };
    ctx.report({ percent: 40, phase: mode });
    if (mode === 'encode' || mode === 'decode') {
      const scope = component ? msg('enc.url.scope.component') : msg('enc.url.scope.url');
      if (mode === 'encode') {
        const encoded = percentEncode(raw, component, form);
        blocks.push(section(msg('enc.url.encodeTitle', { scope })), encoded);
        const escapes = (encoded.match(/%[0-9a-fA-F]{2}/g) ?? []).length;
        blocks.push(
          section(msg('common.section.stats')),
          alignRows([
            [msg('enc.label.inputChars'), codePoints(raw)],
            [msg('enc.label.outputChars'), encoded.length],
            [msg('enc.url.label.escapes'), escapes],
            [msg('enc.url.label.unreserved'), component ? msg('enc.url.value.unreservedComponent') : msg('enc.url.value.unreservedUrl')],
          ]),
        );
        notes.push(component ? msg('enc.url.noteEncodeComponent') : msg('enc.url.noteEncodeUrl'));
        extra = { ...extra, inputChars: codePoints(raw), outputChars: encoded.length, escapes };
      } else {
        const decoded = percentDecode(msg, raw, component, 'input', form);
        blocks.push(section(msg('enc.url.decodeTitle', { scope })), decoded);
        blocks.push(
          section(msg('common.section.stats')),
          alignRows([
            [msg('enc.label.inputChars'), codePoints(raw)],
            [msg('enc.label.outputChars'), codePoints(decoded)],
            [msg('enc.url.label.restored'), (raw.match(/%[0-9a-fA-F]{2}/g) ?? []).length],
            [msg('enc.url.label.plusToSpace'), raw.includes('+') ? msg('enc.url.value.plusCount', { count: raw.split('+').length - 1 }) : msg('enc.url.value.noPlus')],
            [msg('enc.label.reencoded'), percentEncode(decoded, component) === raw ? msg('common.value.yes') : msg('common.value.no')],
          ]),
        );
        notes.push(msg('enc.url.noteDecodePlus'));
        extra = { ...extra, inputChars: codePoints(raw), outputChars: codePoints(decoded) };
      }
    } else if (mode === 'parse') {
      const url = splitUrl(raw);
      const pairs = parsePairs(msg, url.query || (url.hadQuery ? '' : inferQuery(raw)));
      const counts = new Map<string, number>();
      for (const pair of pairs) counts.set(pair.key, (counts.get(pair.key) ?? 0) + 1);
      const repeated = [...counts.entries()].filter(([, count]) => count > 1);
      blocks.push(
        section(msg('enc.url.parseTitle', { count: pairs.length })),
        alignRows([
          [msg('common.label.input'), preview(msg, raw, 96)],
          [msg('enc.url.label.base'), url.base || msg('enc.url.value.notGiven')],
          [msg('enc.url.label.query'), url.query || msg('common.value.blank')],
          [msg('enc.url.label.fragment'), url.hadFragment ? url.fragment || msg('enc.url.value.emptyFragment') : msg('common.value.none')],
          [msg('enc.url.label.repeatedKeys'), repeated.length ? repeated.map(([key, count]) => `${key}×${count}`).join(msg('common.list.sep')) : msg('common.value.none')],
        ]),
      );
      blocks.push(
        section(msg('enc.url.section.details')),
        pairs.length
          ? alignRows(
              pairs.map((pair, index) => [
                `${index + 1}. ${pair.key}${pair.hasValue ? '' : msg('enc.url.value.noEquals')}`,
                pair.rawValue === pair.value ? pair.value || msg('enc.url.value.emptyValue') : msg('enc.url.value.original', { value: pair.value || msg('enc.url.value.emptyValue'), raw: pair.rawValue }),
              ] as Row),
            )
          : msg('enc.url.noParams'),
      );
      notes.push(msg('enc.url.noteParseComponent'));
      notes.push(msg('enc.url.noteParseRepeated'));
      if (!pairs.length) notes.push(msg('enc.url.noteParseFallback'));
      extra = { ...extra, params: pairs.length, repeated: repeated.length };
    } else {
      const lines = raw.split(/[\r\n]+/).map((line) => line.trim()).filter(Boolean);
      const pairs: QueryPair[] = [];
      for (const line of lines) {
        const body = line.startsWith('?') ? line.slice(1) : line;
        const at = body.indexOf('=');
        const key = at < 0 ? body : body.slice(0, at);
        if (!key) throw bad(msg, 'input', msg('enc.url.error.missingKey', { line: lines.indexOf(line) + 1 }), msg('enc.example.queryPair'));
        pairs.push({ key, value: at < 0 ? '' : body.slice(at + 1), rawKey: key, rawValue: at < 0 ? '' : body.slice(at + 1), hasValue: at >= 0 });
      }
      if (!pairs.length) throw bad(msg, 'input', msg('enc.url.error.noLines'), msg('enc.example.queryPair'));
      const query = pairs.map((pair) => `${encodeURIComponent(pair.key)}=${buildValue(pair.value, component)}`).join('&');
      blocks.push(section(msg('enc.url.buildTitle', { scope: component ? msg('enc.url.scope.component') : msg('enc.url.scope.urlProtected') })), query);
      const counts = new Map<string, number>();
      for (const pair of pairs) counts.set(pair.key, (counts.get(pair.key) ?? 0) + 1);
      const repeated = [...counts.entries()].filter(([, count]) => count > 1);
      blocks.push(
        section(msg('enc.url.section.breakdown')),
        alignRows(pairs.map((pair) => [pair.key, pair.hasValue ? pair.value : msg('enc.url.value.noValueWritten')] as Row)),
      );
      blocks.push(
        section(msg('common.section.stats')),
        alignRows([
          [msg('enc.url.label.paramLines'), pairs.length],
          [msg('enc.url.label.queryLength'), query.length],
          [msg('enc.url.label.repeatedKeys'), repeated.length ? repeated.map(([key, count]) => `${key}×${count}`).join(msg('common.list.sep')) : msg('common.value.none')],
          [msg('enc.url.label.parseBack'), parsePairs(msg, query).length === pairs.length ? msg('enc.url.value.consistent') : msg('enc.url.value.checkInput')],
        ]),
      );
      notes.push(msg('enc.url.noteBuildLines'));
      notes.push(component ? msg('enc.url.noteBuildComponent') : msg('enc.url.noteBuildUrl'));
      extra = { ...extra, params: pairs.length, queryLength: query.length };
    }
    blocks.push(section(msg('common.section.notes')), notes.join('\n'));
    await emitText(ctx, 'url-codec.txt', joinBlocks(blocks));
    ctx.report({ percent: 100, phase: 'done' });
    return { extra };
  },
};

function escapeUnicodeStyle(text: string): string {
  let out = '';
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x5c) {
      out += '\\\\';
      continue;
    }
    const simple = SIMPLE_ESCAPES[code];
    if (simple) {
      out += simple;
      continue;
    }
    out += code < 0x20 || code > 0x7e ? `\\u${code.toString(16).padStart(4, '0')}` : text[index]!;
  }
  return out;
}

function escapeJsonStyle(text: string): string {
  const quoted = JSON.stringify(text);
  let out = '';
  for (let index = 0; index < quoted.length; index += 1) {
    const code = quoted.charCodeAt(index);
    out += code > 0x7e ? `\\u${code.toString(16).padStart(4, '0')}` : quoted[index]!;
  }
  return out;
}

function escapeHtmlStyle(text: string, named: boolean): string {
  let out = '';
  for (const char of text) {
    if (named && NAMED_ENTITIES[char]) {
      out += NAMED_ENTITIES[char];
      continue;
    }
    const code = char.codePointAt(0)!;
    out += code < 0x20 || code > 0x7e ? `&#${code};` : char;
  }
  return out;
}

function unescapeUnicodeStyle(msg: Msg, text: string, field: string): string {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char !== '\\') {
      out += char;
      index += 1;
      continue;
    }
    const next = text[index + 1];
    if (next === 'u') {
      const hex = text.slice(index + 2, index + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw bad(msg, field, msg('enc.uni.error.shortU', { position: index + 1 }), '\\u4e2d\\u6587');
      out += String.fromCharCode(Number.parseInt(hex, 16));
      index += 6;
      continue;
    }
    if (next === 'x') {
      const hex = text.slice(index + 2, index + 4);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw bad(msg, field, msg('enc.uni.error.shortX', { position: index + 1 }), '\\x41');
      out += String.fromCharCode(Number.parseInt(hex, 16));
      index += 4;
      continue;
    }
    if (next === undefined) throw bad(msg, field, msg('enc.uni.error.trailingBackslash'), '\\u4e2d\\u6587');
    const mapped = REVERSE_ESCAPES[next];
    if (mapped === undefined) throw bad(msg, field, msg('enc.uni.error.unknownEscape', { char: next, position: index + 1 }), msg('enc.example.unicodeOrNewline'));
    out += mapped;
    index += 2;
  }
  return out;
}

function unescapeJsonStyle(msg: Msg, text: string, field: string): string {
  const body = text.trim();
  if (!body) throw bad(msg, field, msg('enc.uni.error.emptyJson'), '"\\u4e2d\\u6587"');
  const candidate = body.startsWith('"') || body.startsWith('{') || body.startsWith('[') ? body : `"${body}"`;
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (typeof parsed === 'string') return parsed;
    return JSON.stringify(parsed, null, 2);
  } catch (error) {
    throw bad(msg, 
      field,
      msg('enc.uni.error.invalidJson', { message: error instanceof Error ? error.message : String(error) }),
      msg('enc.example.jsonQuoted'),
    );
  }
}

function unescapeHtmlStyle(msg: Msg, text: string, field: string, warnings: string[]): string {
  let out = '';
  let cursor = 0;
  const pattern = /&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g;
  for (;;) {
    const match = pattern.exec(text);
    if (!match) break;
    out += text.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    const body = match[1]!;
    if (body.startsWith('#')) {
      const hexForm = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(body.slice(hexForm ? 2 : 1), hexForm ? 16 : 10);
      if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) {
        throw bad(msg, field, msg('enc.uni.error.entityOutOfRange', { entity: match[0] }), msg('enc.example.htmlEntities'));
      }
      if (code >= 0xd800 && code <= 0xdfff) {
        throw bad(msg, field, msg('enc.uni.error.entitySurrogate', { entity: match[0] }), msg('enc.example.fullCodePoint'));
      }
      out += String.fromCodePoint(code);
      continue;
    }
    const named = NAMED_ENTITY_REVERSE.get(`&${body};`);
    if (named === undefined) {
      warnings.push(msg('enc.uni.warnUnknownEntity', { body }));
      out += match[0];
      continue;
    }
    out += named;
  }
  return out + text.slice(cursor);
}

const UNICODE_STYLES = {
  unicode: 'enc.uni.style.unicode',
  'html-entity': 'enc.uni.style.htmlEntity',
  'html-numeric': 'enc.uni.style.htmlNumeric',
  json: 'enc.uni.style.json',
} as const;
type UnicodeStyle = keyof typeof UNICODE_STYLES;

const unicodeEscapeTool: ToolImpl = {
  id: 'unicode-escape',
  async run(ctx) {
    const msg = makeMsg(localeOf(ctx));
    const raw = needText(msg, ctx, 'input', msg('enc.example.cjkGreeting'));
    const mode = optSelect(ctx, 'mode', ['encode', 'decode'] as const, 'encode');
    const style = optSelect(ctx, 'style', Object.keys(UNICODE_STYLES) as UnicodeStyle[], 'unicode');
    const blocks: string[] = [];
    const notes: string[] = [];
    const warnings: string[] = [];
    let extra: Record<string, string | number> = { mode, style };
    ctx.report({ percent: 40, phase: mode });
    if (mode === 'encode') {
      const output =
        style === 'unicode'
          ? escapeUnicodeStyle(raw)
          : style === 'json'
            ? escapeJsonStyle(raw)
            : escapeHtmlStyle(raw, style === 'html-entity');
      const nonAscii = [...raw].filter((char) => (char.codePointAt(0) ?? 0) > 0x7e).length;
      blocks.push(section(msg('enc.uni.encodeTitle', { style: msg(UNICODE_STYLES[style]) })), output);
      blocks.push(
        section(msg('common.section.stats')),
        alignRows([
          [msg('enc.label.inputChars'), codePoints(raw)],
          [msg('enc.label.outputChars'), codePoints(output)],
          [msg('enc.uni.label.nonAscii'), msg('enc.unit.pieces', { count: nonAscii })],
          [msg('enc.uni.label.escapeFragments'), style === 'unicode' ? (output.match(/\\u[0-9a-fA-F]{4}/g) ?? []).length : style === 'json' ? (output.match(/\\u[0-9a-fA-F]{4}/g) ?? []).length : (output.match(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g) ?? []).length],
          [msg('enc.uni.label.utf8Bytes'), Buffer.byteLength(raw, 'utf8')],
        ]),
      );
      if (style === 'unicode') notes.push(msg('enc.uni.noteUnicode'));
      if (style === 'html-entity') notes.push(msg('enc.uni.noteHtmlEntity'));
      if (style === 'html-numeric') notes.push(msg('enc.uni.noteHtmlNumeric'));
      if (style === 'json') notes.push(msg('enc.uni.noteJson'));
      extra = { ...extra, inputChars: codePoints(raw), outputChars: codePoints(output), nonAscii };
    } else {
      const decoded =
        style === 'unicode'
          ? unescapeUnicodeStyle(msg, raw, 'input')
          : style === 'json'
            ? unescapeJsonStyle(msg, raw, 'input')
            : unescapeHtmlStyle(msg, raw, 'input', warnings);
      if (!decoded) throw bad(msg, 'input', msg('enc.error.emptyAfterUnescape'), style === 'json' ? '"abc"' : style === 'unicode' ? '\\u4e2d\\u6587' : '&#20013;&#25991;');
      const reEncoded =
        style === 'unicode'
          ? escapeUnicodeStyle(decoded)
          : style === 'json'
            ? escapeJsonStyle(decoded)
            : escapeHtmlStyle(decoded, style === 'html-entity');
      blocks.push(section(msg('enc.uni.decodeTitle', { style: msg(UNICODE_STYLES[style]) })), decoded);
      blocks.push(
        section(msg('common.section.stats')),
        alignRows([
          [msg('enc.label.inputChars'), codePoints(raw)],
          [msg('enc.label.outputChars'), codePoints(decoded)],
          [msg('enc.uni.label.nonAscii'), msg('enc.unit.pieces', { count: [...decoded].filter((char) => (char.codePointAt(0) ?? 0) > 0x7e).length })],
          [msg('enc.uni.label.utf8Bytes'), Buffer.byteLength(decoded, 'utf8')],
          [msg('enc.label.reencoded'), reEncoded === raw || (style === 'json' && reEncoded === raw.trim()) ? msg('common.value.yes') : msg('enc.uni.value.canonicalBelow')],
        ]),
      );
      if (reEncoded !== raw) blocks.push(section(msg('enc.uni.section.canonical')), reEncoded);
      notes.push(msg('enc.uni.noteDecodeMixed'));
      if (style === 'unicode') notes.push(msg('enc.uni.noteDecodeUnicode'));
      if (style === 'json') notes.push(msg('enc.uni.noteDecodeJson'));
      if (style === 'html-numeric') notes.push(msg('enc.uni.noteDecodeNumeric'));
      for (const warning of warnings) ctx.warnings.push(warning);
      if (warnings.length) notes.push(msg('enc.uni.noteUnknownEntity'));
      extra = { ...extra, inputChars: codePoints(raw), outputChars: codePoints(decoded), unknownEntities: warnings.length };
    }
    blocks.push(section(msg('common.section.notes')), notes.join('\n'));
    await emitText(ctx, 'unicode-escape.txt', joinBlocks(blocks));
    ctx.report({ percent: 100, phase: 'done' });
    return { extra };
  },
};

export const cryptoEncodingTools: ToolImpl[] = [
  hashTool,
  hmacTool,
  fileChecksumTool,
  base64Tool,
  radixTool,
  hexTool,
  urlCodecTool,
  unicodeEscapeTool,
];
