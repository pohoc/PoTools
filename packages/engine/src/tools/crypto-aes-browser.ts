import { EngineError } from '../errors.ts';
import { localeOf, makeMsg } from '../lib/messages.ts';
import type { ToolImpl, ToolResult } from '../types.ts';
import { alignRows, emitText, joinBlocks, optNum, optSelect, optStr, section } from './time-core.ts';

const CIPHERS = ['aes-256-gcm', 'aes-256-cbc', 'aes-128-cbc', 'aes-256-ctr'] as const;
type Cipher = typeof CIPHERS[number];
type Kdf = 'scrypt' | 'pbkdf2';
const CIPHER_ID: Record<Cipher, number> = { 'aes-256-gcm': 1, 'aes-256-cbc': 2, 'aes-128-cbc': 3, 'aes-256-ctr': 4 };
const ID_CIPHER = Object.fromEntries(Object.entries(CIPHER_ID).map(([key, value]) => [value, key])) as Record<number, Cipher>;
type Format = 'base64' | 'base64url' | 'hex';

function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
function source(bytes: Uint8Array): ArrayBuffer { return Uint8Array.from(bytes).buffer; }
function hex(bytes: Uint8Array): string { return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join(''); }
function encode(bytes: Uint8Array, format: Format): string {
  if (format === 'hex') return hex(bytes);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  const base64 = btoa(binary);
  return format === 'base64url' ? base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : base64;
}
function decode(raw: string, format: Format): Uint8Array {
  const compact = raw.replace(/\s/g, '');
  if (format === 'hex') {
    if (!/^(?:[\da-f]{2})+$/i.test(compact)) throw new EngineError('bad_request', '输入不是有效的十六进制数据');
    return Uint8Array.from(compact.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
  }
  const normalized = compact.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(compact.length / 4) * 4, '=');
  try { return Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0)); }
  catch { throw new EngineError('bad_request', '输入不是有效的 Base64 数据'); }
}
function join(parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}
function scryptCost(iterations: number): number { return 2 ** clamp(Math.floor(Math.log2(Math.max(iterations, 1))), 14, 16); }
function pack(fields: { cipher: Cipher; kdf: Kdf; iterations: number; salt: Uint8Array; iv: Uint8Array; tag: Uint8Array; data: Uint8Array }): Uint8Array {
  const header = new Uint8Array(7);
  header.set([1, fields.kdf === 'scrypt' ? 1 : 2, CIPHER_ID[fields.cipher]], 0);
  new DataView(header.buffer).setUint32(3, fields.iterations, false);
  return join([header, Uint8Array.of(fields.salt.length), fields.salt, Uint8Array.of(fields.iv.length), fields.iv, Uint8Array.of(fields.tag.length), fields.tag, fields.data]);
}
function unpack(bytes: Uint8Array): { cipher: Cipher; kdf: Kdf; iterations: number; salt: Uint8Array; iv: Uint8Array; tag: Uint8Array; data: Uint8Array } {
  if (bytes.length < 7 || bytes[0] !== 1 || (bytes[1] !== 1 && bytes[1] !== 2)) throw new EngineError('bad_request', '输入不是支持的 AES 加密容器');
  const cipher = ID_CIPHER[bytes[2] ?? 0];
  if (!cipher) throw new EngineError('bad_request', '加密容器使用了不支持的算法');
  const iterations = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(3, false) || 150000;
  let offset = 7;
  const field = (name: string, max: number): Uint8Array => {
    const length = bytes[offset++] ?? 0;
    if (length > max || offset + length > bytes.length) throw new EngineError('bad_request', `加密容器中的 ${name} 字段无效`);
    const value = bytes.slice(offset, offset + length); offset += length; return value;
  };
  const salt = field('salt', 64); const iv = field('IV', 32); const tag = field('authTag', 32);
  if (salt.length !== 16 || iv.length !== (cipher === 'aes-256-gcm' ? 12 : 16) || (cipher === 'aes-256-gcm' && tag.length !== 16)) {
    throw new EngineError('bad_request', '加密容器参数无效');
  }
  return { cipher, kdf: bytes[1] === 1 ? 'scrypt' : 'pbkdf2', iterations, salt, iv, tag, data: bytes.slice(offset) };
}
function salsa208(block: Uint32Array): Uint32Array<ArrayBufferLike> {
  const x = new Uint32Array(16);
  x.set(block);
  const xor = (index: number, value: number) => { x[index] = (x[index] ?? 0) ^ value; };
  const rotl = (value: number, count: number) => (value << count) | (value >>> (32 - count));
  for (let round = 0; round < 8; round += 2) {
    xor(4, rotl((x[0]! + x[12]!) >>> 0, 7)); xor(8, rotl((x[4]! + x[0]!) >>> 0, 9));
    xor(12, rotl((x[8]! + x[4]!) >>> 0, 13)); xor(0, rotl((x[12]! + x[8]!) >>> 0, 18));
    xor(9, rotl((x[5]! + x[1]!) >>> 0, 7)); xor(13, rotl((x[9]! + x[5]!) >>> 0, 9));
    xor(1, rotl((x[13]! + x[9]!) >>> 0, 13)); xor(5, rotl((x[1]! + x[13]!) >>> 0, 18));
    xor(14, rotl((x[10]! + x[6]!) >>> 0, 7)); xor(2, rotl((x[14]! + x[10]!) >>> 0, 9));
    xor(6, rotl((x[2]! + x[14]!) >>> 0, 13)); xor(10, rotl((x[6]! + x[2]!) >>> 0, 18));
    xor(3, rotl((x[15]! + x[11]!) >>> 0, 7)); xor(7, rotl((x[3]! + x[15]!) >>> 0, 9));
    xor(11, rotl((x[7]! + x[3]!) >>> 0, 13)); xor(15, rotl((x[11]! + x[7]!) >>> 0, 18));
    xor(1, rotl((x[0]! + x[3]!) >>> 0, 7)); xor(2, rotl((x[1]! + x[0]!) >>> 0, 9));
    xor(3, rotl((x[2]! + x[1]!) >>> 0, 13)); xor(0, rotl((x[3]! + x[2]!) >>> 0, 18));
    xor(6, rotl((x[5]! + x[4]!) >>> 0, 7)); xor(7, rotl((x[6]! + x[5]!) >>> 0, 9));
    xor(4, rotl((x[7]! + x[6]!) >>> 0, 13)); xor(5, rotl((x[4]! + x[7]!) >>> 0, 18));
    xor(11, rotl((x[10]! + x[9]!) >>> 0, 7)); xor(8, rotl((x[11]! + x[10]!) >>> 0, 9));
    xor(9, rotl((x[8]! + x[11]!) >>> 0, 13)); xor(10, rotl((x[9]! + x[8]!) >>> 0, 18));
    xor(12, rotl((x[15]! + x[14]!) >>> 0, 7)); xor(13, rotl((x[12]! + x[15]!) >>> 0, 9));
    xor(14, rotl((x[13]! + x[12]!) >>> 0, 13)); xor(15, rotl((x[14]! + x[13]!) >>> 0, 18));
  }
  for (let i = 0; i < 16; i++) x[i] = (x[i]! + block[i]!) >>> 0;
  return x;
}

function blockMix(input: Uint32Array, r: number): Uint32Array<ArrayBufferLike> {
  const blocks = 2 * r;
  let x: Uint32Array<ArrayBufferLike> = input.slice((blocks - 1) * 16, blocks * 16);
  const y = new Uint32Array(input.length);
  for (let i = 0; i < blocks; i++) {
    const block = input.subarray(i * 16, (i + 1) * 16);
    for (let j = 0; j < 16; j++) x[j] = x[j]! ^ block[j]!;
    x = salsa208(x);
    y.set(x, i * 16);
  }
  const output = new Uint32Array(input.length);
  for (let i = 0; i < r; i++) {
    output.set(y.subarray(2 * i * 16, (2 * i + 1) * 16), i * 16);
    output.set(y.subarray((2 * i + 1) * 16, (2 * i + 2) * 16), (i + r) * 16);
  }
  return output;
}

function romix(input: Uint32Array, n: number, r: number): Uint32Array<ArrayBufferLike> {
  const words = 32 * r;
  let x: Uint32Array<ArrayBufferLike> = Uint32Array.from(input);
  const v = new Uint32Array(n * words);
  for (let i = 0; i < n; i++) { v.set(x, i * words); x = blockMix(x, r); }
  for (let i = 0; i < n; i++) {
    const j = (x[(2 * r - 1) * 16]! & (n - 1)) * words;
    for (let k = 0; k < words; k++) x[k] = x[k]! ^ v[j + k]!;
    x = blockMix(x, r);
  }
  return x;
}

async function scrypt(passphrase: string, salt: Uint8Array, iterations: number, keyLength: number, cost = scryptCost(iterations), r = 8, p = 1): Promise<Uint8Array> {
  const n = cost; const words = 32 * r;
  const material = await crypto.subtle.importKey('raw', source(new TextEncoder().encode(passphrase)), 'PBKDF2', false, ['deriveBits']);
  const initial = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: source(salt), iterations: 1 }, material, p * words * 32));
  const b = new Uint32Array(initial.buffer, initial.byteOffset, initial.byteLength / 4);
  for (let lane = 0; lane < p; lane++) {
    const xStart = lane * words;
    const x = romix(b.subarray(xStart, xStart + words), n, r);
    b.set(x, xStart);
  }
  const finalSalt = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  const derived = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: source(finalSalt), iterations: 1 }, material, keyLength * 8);
  return new Uint8Array(derived);
}


async function derive(passphrase: string, salt: Uint8Array, iterations: number, keyBits: 128 | 256, cipher: Cipher, kdf: Kdf): Promise<CryptoKey> {
  const name = cipher === 'aes-256-gcm' ? 'AES-GCM' : cipher === 'aes-256-ctr' ? 'AES-CTR' : 'AES-CBC';
  if (kdf === 'scrypt') {
    const raw = await scrypt(passphrase, salt, iterations, keyBits / 8);
    return crypto.subtle.importKey('raw', source(raw), { name, length: keyBits }, false, ['encrypt', 'decrypt']);
  }
  const material = await crypto.subtle.importKey('raw', source(new TextEncoder().encode(passphrase)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: source(salt), iterations }, material, { name, length: keyBits }, false, ['encrypt', 'decrypt']);
}
function algorithm(cipher: Cipher, iv: Uint8Array): AesGcmParams | AesCbcParams | AesCtrParams {
  if (cipher === 'aes-256-gcm') return { name: 'AES-GCM', iv: source(iv), tagLength: 128 };
  if (cipher === 'aes-256-ctr') return { name: 'AES-CTR', counter: source(iv), length: 128 };
  return { name: 'AES-CBC', iv: source(iv) };
}

/** WebCrypto AES adapter with compatible PBKDF2 and scrypt container formats. */
export const embeddedAesTool: ToolImpl = {
  id: 'aes',
  async run(ctx): Promise<ToolResult> {
    const msg = makeMsg(localeOf(ctx));
    const input = optStr(ctx, 'input');
    const passphrase = optStr(ctx, 'passphrase');
    if (!input) throw new EngineError('bad_request', msg('sec.aes.reason.1'));
    if (!passphrase) throw new EngineError('bad_request', msg('sec.aes.reason.3'));
    const mode = optSelect(ctx, 'mode', ['encrypt', 'decrypt'] as const, 'encrypt');
    const format = optSelect(ctx, 'format', ['base64', 'base64url', 'hex'] as const, 'base64');
    const iterations = clamp(Math.round(optNum(ctx, 'iterations', 150000)), 1000, 2_000_000);
    if (mode === 'encrypt') {
      const kdf = optSelect(ctx, 'kdf', ['scrypt', 'pbkdf2'] as const, 'scrypt');
      const cipher = optSelect(ctx, 'cipher', CIPHERS, 'aes-256-gcm');
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iv = crypto.getRandomValues(new Uint8Array(cipher === 'aes-256-gcm' ? 12 : 16));
      const plain = new TextEncoder().encode(input);
      ctx.report({ percent: 35, phase: 'derive-key' });
      const key = await derive(passphrase, salt, iterations, cipher === 'aes-128-cbc' ? 128 : 256, cipher, kdf);
      const encrypted = new Uint8Array(await crypto.subtle.encrypt(algorithm(cipher, iv), key, source(plain)));
      const tag = cipher === 'aes-256-gcm' ? encrypted.slice(-16) : new Uint8Array();
      const data = cipher === 'aes-256-gcm' ? encrypted.slice(0, -16) : encrypted;
      const container = pack({ cipher, kdf, iterations, salt, iv, tag, data });
      const rendered = encode(container, format);
      await emitText(ctx, 'aes.txt', joinBlocks([
        section(msg('sec.aes.section.3')),
        rendered,
        section(msg('sec.aes.section.1', { cipher, kdf, format })),
        alignRows([
          [msg('sec.rsa.section.1'), msg('sec.aes.row.1', { plain: plain.length })],
          [msg('sec.aes.row.2'), msg('sec.aes.row.3', { data: data.length })],
          [msg('sec.aes.row.4'), msg('sec.aes.row.5', { container: container.length, rendered: rendered.length })],
          ['salt', msg('sec.aes.row.6', { salt: hex(salt) })],
          ['IV/nonce', msg('sec.aes.row.7', { iv: hex(iv), iv2: iv.length })],
          ['authTag', cipher === 'aes-256-gcm' ? msg('sec.aes.row.8', { tag: hex(tag) }) : msg('sec.aes.row.9')],
          [msg('sec.aes.row.10'), kdf === 'scrypt' ? msg('sec.aes.row.11', { iterations: scryptCost(iterations), iterations2: iterations }) : msg('sec.aes.section.2', { iterations })],
        ]),
        section(msg('sec.aes.section.4')),
        `${msg('sec.container.text.1')}\n  ${msg('sec.container.text.2')}${msg('sec.aes.row.12')}`,
        section(msg('common.section.notes')),
        [msg('sec.aes.row.13'), msg('sec.aes.row.14'), msg('sec.aes.row.15'), msg('sec.aes.row.16')].join('\n'),
      ]));
      ctx.report({ percent: 100, phase: 'done' });
      return { extra: { mode, cipher, kdf, iterations, encoding: format, containerBytes: container.length, container: rendered } };
    }
    const packed = unpack(decode(input, format));
    ctx.report({ percent: 35, phase: 'derive-key' });
    const key = await derive(passphrase, packed.salt, packed.iterations, packed.cipher === 'aes-128-cbc' ? 128 : 256, packed.cipher, packed.kdf);
    const payload = packed.cipher === 'aes-256-gcm' ? join([packed.data, packed.tag]) : packed.data;
    try {
      const plain = new Uint8Array(await crypto.subtle.decrypt(algorithm(packed.cipher, packed.iv), key, source(payload)));
      const text = new TextDecoder('utf-8', { fatal: false }).decode(plain);
      await emitText(ctx, 'aes.txt', joinBlocks([
        section(msg('sec.aes.section.10', { cipher: packed.cipher, kdf: packed.kdf })),
        section(msg('common.label.result')),
        text,
        alignRows([
          [msg('sec.aes.row.17'), msg('sec.aes.row.18', { containerBytes: decode(input, format).length })],
          [msg('sec.rsa.row.1'), msg('sec.aes.row.3', { data: packed.data.length })],
          [msg('sec.rsa.row.3'), msg('sec.rsa.row.2', { plain: plain.length })],
          [msg('sec.aes.row.24'), `${packed.cipher} · ${packed.kdf} · iterations=${packed.iterations}`],
        ]),
        section(msg('common.section.notes')),
        [msg('sec.aes.row.30'), msg('sec.aes.row.31'), packed.cipher === 'aes-256-gcm' ? msg('sec.aes.row.32') : msg('sec.aes.row.33')].join('\n'),
      ]));
      ctx.report({ percent: 100, phase: 'done' });
      return { extra: { mode, cipher: packed.cipher, kdf: packed.kdf, ok: 'yes', bytes: plain.length, text } };
    } catch {
      const message = packed.cipher === 'aes-256-gcm' ? msg('sec.aes.text.1') : msg('sec.aes.text.2', { cipher: packed.cipher });
      await emitText(ctx, 'aes.txt', joinBlocks([section(msg('sec.aes.section.5', { cipher: packed.cipher, kdf: packed.kdf })), `✗ ${message}`]));
      ctx.report({ percent: 100, phase: 'done' });
      return { extra: { mode, cipher: packed.cipher, kdf: packed.kdf, ok: 'no', reason: message } };
    }
  },
};
