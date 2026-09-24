import {
  constants as nodeConstants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  pbkdf2Sync,
  randomBytes,
  scryptSync,
  timingSafeEqual,
  X509Certificate,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { EngineError } from '../errors.ts';
import type { ToolContext, ToolImpl, ToolResult } from '../types.ts';
import { embeddedCryptoPrimitiveTools } from './crypto-primitives-browser.ts';
import { localeOf, makeMsg } from '../lib/messages.ts';
import { alignRows, DAY_MS, emitText, joinBlocks, optBool, optNum, optSelect, optStr, parseFlex, phraseLocale, relativePhrase, section } from './time-core.ts';
import type { MsgLocale, Row } from './time-core.ts';

type Msg = ReturnType<typeof makeMsg>;

type JwtAlg = 'auto' | 'hs256' | 'hs384' | 'hs512' | 'rs256' | 'es256';
type RsaMode = 'generate' | 'encrypt' | 'decrypt' | 'sign' | 'verify' | 'pubkey';
type AesCipher = 'aes-256-gcm' | 'aes-256-cbc' | 'aes-128-cbc' | 'aes-256-ctr';
type AesFormat = 'base64' | 'base64url' | 'hex';
type Kdf = 'scrypt' | 'pbkdf2';
type LoadedKey = { readonly keyObject: KeyObject; readonly label: string; readonly text: string; readonly derived: boolean };

const JWT_ALGS: readonly JwtAlg[] = ['auto', 'hs256', 'hs384', 'hs512', 'rs256', 'es256'];
const RSA_MODES: readonly RsaMode[] = ['generate', 'encrypt', 'decrypt', 'sign', 'verify', 'pubkey'];
const AES_CIPHERS: readonly AesCipher[] = ['aes-256-gcm', 'aes-256-cbc', 'aes-128-cbc', 'aes-256-ctr'];
const AES_FORMATS: readonly AesFormat[] = ['base64', 'base64url', 'hex'];
const KDF_NAMES: readonly Kdf[] = ['scrypt', 'pbkdf2'];

const CIPHER_IDS: Record<number, AesCipher> = { 1: 'aes-256-gcm', 2: 'aes-256-cbc', 3: 'aes-128-cbc', 4: 'aes-256-ctr' };
const CIPHER_CODES: Record<AesCipher, number> = { 'aes-256-gcm': 1, 'aes-256-cbc': 2, 'aes-128-cbc': 3, 'aes-256-ctr': 4 };
const KDF_IDS: Record<Kdf, number> = { scrypt: 1, pbkdf2: 2 };

const CONTAINER_LAYOUT =
  'sec.container.text.1';
const CONTAINER_ALG_IDS = 'sec.container.text.2';

const HS_MAP: Record<string, 'sha256' | 'sha384' | 'sha512'> = { hs256: 'sha256', hs384: 'sha384', hs512: 'sha512' };

function bad(msg: Msg, field: string, reason: string, example: string): EngineError {
  return new EngineError('bad_request', msg('common.error.badField', { field: field, reason: reason, example: example }));
}

function need(msg: Msg, ctx: ToolContext, key: string, label: string, example: string): string {
  const raw = optStr(ctx, key);
  if (!raw) throw bad(msg, key, msg('sec.need.reason.1', { label: label }), example);
  return raw;
}

function rawOption(ctx: ToolContext, key: string): string {
  const value = ctx.options[key];
  if (value === undefined || value === null) return '';
  return String(value).replace(/\r\n/g, '\n').replace(/\s+$/, '');
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function buf(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function utf8(bytes: Uint8Array | Buffer): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function hexOf(bytes: Uint8Array | Buffer): string {
  return Buffer.from(buf(bytes as Uint8Array)).toString('hex');
}

function groupedFingerprint(bytes: Uint8Array, algorithm: 'sha1' | 'sha256'): string {
  return hexOf(new Uint8Array(createHash(algorithm).update(buf(bytes)).digest()))
    .replace(/(.{2})(?!$)/g, '$1:')
    .toUpperCase();
}

type AesHandle = { update(data: Buffer): Buffer; final(): Buffer; getAuthTag(): Buffer; setAuthTag(tag: Buffer): void };

function makeHandle(kind: 'encrypt' | 'decrypt', cipher: AesCipher, key: Buffer, iv: Buffer, tagLength: number): AesHandle {
  const gcm = tagLength > 0;
  if (kind === 'encrypt') {
    return (gcm ? createCipheriv('aes-256-gcm', key, iv, { authTagLength: tagLength }) : createCipheriv(cipher as 'aes-256-cbc', key, iv)) as unknown as AesHandle;
  }
  return (gcm ? createDecipheriv('aes-256-gcm', key, iv, { authTagLength: tagLength }) : createDecipheriv(cipher as 'aes-256-cbc', key, iv)) as unknown as AesHandle;
}

function b64urlDecode(msg: Msg, segment: string, field: string): Uint8Array {
  const cleaned = segment.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  if (!cleaned) throw bad(msg, field, msg('sec.b64urlDecode.reason.1'), 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.9igT');
  if (!/^[A-Za-z0-9_-]+$/.test(cleaned)) throw bad(msg, field, msg('sec.b64urlDecode.reason.2', { cleaned: cleaned.slice(0, 20) }), 'eyJhbGciOiJIUzI1NiJ9');
  const decoded = Buffer.from(cleaned, 'base64url');
  if (!decoded.length) throw bad(msg, field, msg('sec.decodeBase32.reason.1'), 'eyJhbGciOiJIUzI1NiJ9');
  return new Uint8Array(decoded);
}

function pemBlocks(text: string, labelPattern: string): string[] {
  return [...text.matchAll(new RegExp(`-----BEGIN ${labelPattern}-----(?:[\\s\\S]*?)-----END ${labelPattern}-----`, 'g'))].map((match) => match[0].trim());
}

function pemLabel(msg: Msg, block: string): string {
  return (/-----BEGIN ([A-Z0-9 ]+)-----/.exec(block) ?? [])[1] ?? msg('common.value.unknown');
}

function normalizePem(msg: Msg, block: string): string {
  const label = pemLabel(msg, block);
  const body = block.replace(/-----BEGIN [A-Z0-9 ]+-----/g, '').replace(/-----END [A-Z0-9 ]+-----/g, '').replace(/\s/g, '');
  return `-----BEGIN ${label}-----\n${(body.match(/.{1,64}/g) ?? []).join('\n')}\n-----END ${label}-----\n`;
}

function jwkIsPrivate(jwk: JsonWebKey): boolean {
  return Boolean((jwk as unknown as Record<string, unknown>).d);
}

function jwkList(input: string): JsonWebKey[] {
  const trimmed = input.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const source = Array.isArray(parsed) ? parsed : [((parsed as Record<string, unknown>)?.keys ?? parsed)];
    return source.filter((item): item is JsonWebKey => !!item && typeof item === 'object' && typeof (item as JsonWebKey).kty === 'string');
  } catch {
    return [];
  }
}

function keyCandidates(msg: Msg, input: string, passphrase: string): Array<{ label: string; build: () => KeyObject }> {
  const out: Array<{ label: string; build: () => KeyObject }> = [];
  const pass = passphrase || undefined;
  for (const block of pemBlocks(input, '[A-Z0-9 ]+')) {
    const label = pemLabel(msg, block);
    if (label === 'CERTIFICATE') continue;
    const pem = normalizePem(msg, block);
    if (label === 'PUBLIC KEY') out.push({ label: msg('sec.keyCandidates.note.1'), build: () => createPublicKey({ key: pem, format: 'pem', type: 'spki' }) });
    else if (label === 'RSA PUBLIC KEY') out.push({ label: msg('sec.keyCandidates.note.2'), build: () => createPublicKey({ key: pem, format: 'pem', type: 'pkcs1' }) });
    else if (label === 'RSA PRIVATE KEY') out.push({ label: msg('sec.keyCandidates.note.3'), build: () => createPrivateKey({ key: pem, format: 'pem', type: 'pkcs1', passphrase: pass }) });
    else if (label === 'EC PRIVATE KEY') out.push({ label: msg('sec.keyCandidates.note.4'), build: () => createPrivateKey({ key: pem, format: 'pem', type: 'sec1', passphrase: pass }) });
    else {
      out.push({ label: `PKCS#8 ${label.toLowerCase()}`, build: () => createPrivateKey({ key: pem, format: 'pem', type: 'pkcs8', passphrase: pass }) });
      out.push({ label: msg('sec.keyCandidates.note.3'), build: () => createPrivateKey({ key: pem, format: 'pem', type: 'pkcs1', passphrase: pass }) });
    }
  }
  for (const jwk of jwkList(input)) {
    const owned = jwkIsPrivate(jwk);
    out.push({ label: `JWK ${jwk.kty}${owned ? msg('sec.keyCandidates.note.5') : msg('sec.keyCandidates.note.6')}`, build: () => (owned ? createPrivateKey({ key: jwk, format: 'jwk' }) : createPublicKey({ key: jwk, format: 'jwk' })) });
  }
  const compact = input.trim().replace(/\s/g, '');
  if (!out.length && compact.length > 32 && /^[A-Za-z0-9+/_=-]+$/.test(compact)) {
    const der = Buffer.from(compact.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (der.length) {
      out.push({ label: msg('sec.keyCandidates.note.7'), build: () => createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }) });
      out.push({ label: msg('sec.keyCandidates.note.8'), build: () => createPublicKey({ key: der, format: 'der', type: 'spki' }) });
    }
  }
  return out;
}

function loadKey(msg: Msg, input: string, kind: 'private' | 'public', passphrase: string, field: string): LoadedKey {
  const example = kind === 'private' ? '-----BEGIN PRIVATE KEY-----…' : '-----BEGIN PUBLIC KEY-----…';
  const encryptedKey = /-----BEGIN ENCRYPTED PRIVATE KEY-----|Proc-Type:[^\n]*ENCRYPTED/i.test(input);
  if (kind === 'private' && encryptedKey && !passphrase) throw bad(msg, 'passphrase', msg('sec.loadKey.reason.1', { field: field }), msg('sec.loadKey.reason.2'));
  const candidates = keyCandidates(msg, input, passphrase);
  if (!candidates.length) {
    throw bad(msg, field, kind === 'private' ? msg('sec.loadKey.reason.3') : msg('sec.loadKey.reason.4'), example);
  }
  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      const built = candidate.build();
      if (kind === 'public') {
        const derived = built.type === 'private';
        const keyObject = derived ? createPublicKey(built) : built;
        return { keyObject, label: `${derived ? msg('sec.loadKey.text.1') : ''}${candidate.label} · ${keyKindLabel(msg, keyObject)}`, text: String(keyObject.export({ type: 'spki', format: 'pem' })), derived };
      }
      if (built.type !== 'private') {
        failures.push(msg('sec.loadKey.note.1', { label: candidate.label }));
        continue;
      }
      return { keyObject: built, label: candidate.label, text: String(built.export({ type: 'pkcs8', format: 'pem' })), derived: false };
    } catch (error) {
      failures.push(msg('sec.loadKey.notex.1', { label: candidate.label, message: (error as Error).message }));
    }
  }
  const passphraseish = encryptedKey || failures.some((message) => /passphrase|bad decrypt|decoding|final block|no password|padding check/i.test(message));
  if (passphraseish && !passphrase) throw bad(msg, 'passphrase', msg('sec.loadKey.reason.5', { field: field }), msg('sec.loadKey.reason.2'));
  if (passphraseish) throw bad(msg, 'passphrase', msg('sec.loadKey.reason.6', { field: field }), msg('sec.loadKey.reason.2'));
  throw bad(msg, field, msg('sec.loadKey.reason.7', { reason: failures[0] ?? msg('sec.loadKey.reason.8') }), example);
}

function keyKindLabel(msg: Msg, keyObject: KeyObject): string {
  const details = keyObject.asymmetricKeyDetails ?? {};
  const size = Number((details as { modulusLength?: number }).modulusLength ?? 0);
  return `${keyObject.asymmetricKeyType ?? msg('common.value.unknown')}${size ? ` · ${size} bit` : ''}`;
}

function requirePrivate(msg: Msg, ctx: ToolContext, field: string): LoadedKey {
  const raw = rawOption(ctx, field);
  if (!raw) throw bad(msg, field, msg('sec.requirePrivate.reason.1'), '-----BEGIN PRIVATE KEY-----…');
  return loadKey(msg, raw, 'private', rawOption(ctx, 'passphrase'), field);
}

function requirePublic(msg: Msg, ctx: ToolContext, field: string): LoadedKey {
  const raw = rawOption(ctx, field);
  if (!raw) throw bad(msg, field, msg('sec.requirePublic.reason.1'), '-----BEGIN PUBLIC KEY-----…');
  return loadKey(msg, raw, 'public', rawOption(ctx, 'passphrase'), field);
}

function exportJwk(keyObject: KeyObject, type: 'private' | 'public'): string {
  const jwk = keyObject.export({ type: type === 'public' ? 'spki' : 'pkcs8', format: 'jwk' }) as JsonWebKey;
  const out: Record<string, unknown> = { ...jwk };
  if (jwk.kty === 'RSA') out.alg = type === 'public' ? 'RS256' : 'PS256';
  return `${JSON.stringify(out, null, 2)}\n`;
}

function localTime(uiLocale: MsgLocale, ms: number): string {
  return new Date(ms).toLocaleString(phraseLocale(uiLocale, 'zh-CN'), { hour12: false });
}

function epochText(uiLocale: MsgLocale, seconds: number): string {
  return `${localTime(uiLocale, seconds * 1000)} · ${new Date(seconds * 1000).toISOString()} · T=${seconds}`;
}

function agoText(uiLocale: MsgLocale, deltaMs: number): string {
  return relativePhrase(deltaMs, phraseLocale(uiLocale, 'zh-CN'));
}

/* ── JWT ───────────────────────────────────────────────────────────────────── */

const jwtTool: ToolImpl = {
  id: 'jwt',
  async run(ctx): Promise<ToolResult> {
    const uiLocale = localeOf(ctx);
    const msg = makeMsg(uiLocale);
    const raw = need(msg, ctx, 'token', msg('sec.jwt.reason.1'), 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.…');
    const compact = raw.replace(/\s/g, '');
    const parts = compact.split('.');
    if (parts.length !== 3) throw bad(msg, 'token', msg('sec.jwt.reason.2', { parts: parts.length }), 'eyJhbGciOi….eyJzdWIiOi….SflKxwRJ…');
    const secret = rawOption(ctx, 'secret');
    const verifyRequested = optBool(ctx, 'verify', false);
    const requested = optSelect(ctx, 'algorithm', JWT_ALGS, 'auto');
    const leeway = clamp(Math.round(optNum(ctx, 'leeway', 0)), 0, 3600);

    const headerText = utf8(b64urlDecode(msg, parts[0]!, 'token(header)'));
    const payloadText = utf8(b64urlDecode(msg, parts[1]!, 'token(payload)'));
    const signature = b64urlDecode(msg, parts[2]!, 'token(signature)');
    const header = parseJsonRecord(msg, headerText, 'header');
    const claims = parseJsonRecord(msg, payloadText, 'payload');
    ctx.report({ percent: 45, phase: 'decode' });

    const headerAlg = String(header.alg ?? msg('common.value.missing'));
    const resolved = (requested === 'auto' ? headerAlg : requested).toLowerCase() as JwtAlg;
    if (!JWT_ALGS.includes(resolved) || resolved === 'auto') {
      throw bad(msg, 'algorithm', msg('sec.jwt.reason.3', { headerAlg: headerAlg }), 'hs256');
    }
    const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8');
    const nowSeconds = Math.floor(Date.now() / 1000);
    const exp = typeof claims.exp === 'number' ? claims.exp : null;
    const nbf = typeof claims.nbf === 'number' ? claims.nbf : null;
    const iat = typeof claims.iat === 'number' ? claims.iat : null;
    const expired = exp !== null && nowSeconds - leeway > exp;
    const notYetValid = nbf !== null && nowSeconds + leeway < nbf;

    const timeline: Row[] = [];
    if (iat !== null) timeline.push([msg('sec.jwt.note.1'), `${epochText(uiLocale, iat)} · ${agoText(uiLocale, iat * 1000 - Date.now())}`]);
    if (nbf !== null) timeline.push([msg('sec.jwt.note.2'), `${epochText(uiLocale, nbf)} · ${notYetValid ? msg('sec.jwt.note.3', { nowSeconds: nbf + leeway - nowSeconds }) : msg('sec.jwt.note.4', { now: agoText(uiLocale, nbf * 1000 - Date.now()) })}`]);
    if (exp !== null) timeline.push([msg('sec.jwt.note.5'), `${epochText(uiLocale, exp)} · ${expired ? msg('sec.jwt.note.6', { leeway: nowSeconds - exp - leeway }) : msg('sec.jwt.note.7', { nowSeconds: exp - leeway - nowSeconds, now: agoText(uiLocale, exp * 1000 - Date.now()) })}`]);
    timeline.push(['leeway', msg('sec.jwt.note.8', { leeway: leeway })]);
    timeline.push([msg('sec.jwt.note.9'), expired ? msg('sec.jwt.note.10') : notYetValid ? msg('sec.jwt.note.11') : exp === null ? msg('sec.jwt.note.12') : msg('sec.validityRows.row.1')]);

    let verifyResult = msg('sec.jwt.text.1');
    let verifyMethod = '—';
    if (verifyRequested) {
      if (!secret) {
        throw new EngineError('bad_request', msg('sec.jwt.error.1', { resolved: resolved.toUpperCase(), error: resolved.startsWith('hs') ? msg('sec.jwt.error.2') : msg('sec.jwt.error.3') }));
      }
      if (resolved in HS_MAP) {
        const expected = new Uint8Array(createHmac(HS_MAP[resolved]!, Buffer.from(secret, 'utf8')).update(signingInput).digest());
        const matched = signature.length === expected.length && timingSafeEqual(buf(signature), buf(expected));
        verifyResult = matched ? msg('sec.jwt.text.2') : msg('sec.jwt.text.3');
        verifyMethod = msg('sec.jwt.text.4', { resolved: HS_MAP[resolved]!.toUpperCase(), expected: hexOf(expected), signature: hexOf(signature) });
      } else {
        const loaded = loadKey(msg, secret, 'public', '', 'secret');
        const verifier = createVerify(resolved === 'rs256' ? 'RSA-SHA256' : 'SHA256');
        verifier.update(signingInput);
        let matched = false;
        try {
          matched = resolved === 'es256' ? verifier.verify({ key: loaded.keyObject, dsaEncoding: 'ieee-p1363' }, buf(signature)) : verifier.verify(loaded.keyObject, buf(signature));
        } catch (error) {
          verifyResult = msg('sec.jwt.text.5', { message: (error as Error).message });
        }
        if (!verifyResult.startsWith(msg('sec.jwt.text.6'))) verifyResult = matched ? msg('sec.jwt.text.2') : msg('sec.jwt.text.3');
        verifyMethod = `${resolved.toUpperCase()} · ${loaded.label}${resolved === 'es256' ? msg('sec.jwt.text.7') : ''} · crypto.verify`;
      }
      if (verifyResult.startsWith('✓') && expired) verifyResult = msg('sec.jwt.text.8');
      if (verifyResult.startsWith('✓') && notYetValid) verifyResult = msg('sec.jwt.text.9');
    }
    ctx.report({ percent: 85, phase: 'verify' });

    const known: Row[] = [];
    for (const key of ['iss', 'sub', 'aud', 'jti', 'typ'] as const) {
      if (claims[key] !== undefined) known.push([key, JSON.stringify(claims[key]) ?? 'null']);
    }

    const blocks = [
      section(`JWT · ${headerAlg}${verifyRequested ? msg('sec.jwt.section.1') : msg('sec.jwt.section.2')}`),
      alignRows([
        [msg('sec.jwt.row.2'), msg('sec.jwt.row.3', { parts: parts[0]!.length, parts2: parts[1]!.length, parts3: parts[2]!.length })],
        [msg('sec.jwt.row.4'), msg('sec.jwt.row.5', { signature: signature.length, signature2: hexOf(signature) })],
        [msg('sec.jwt.row.6'), msg('sec.jwt.row.7', { headerAlg: headerAlg, resolved: resolved.toUpperCase() })],
        [msg('sec.jwt.row.8'), String(header.typ ?? msg('common.value.missing'))],
        [msg('sec.jwt.section.3'), `${parts[0]}.${parts[1]}`],
      ]),
      section(msg('sec.jwt.section.4')),
      JSON.stringify(header, null, 2),
      section(msg('sec.jwt.section.5')),
      JSON.stringify(claims, null, 2),
      section(msg('sec.jwt.section.6')),
      alignRows([...known, ...timeline]),
      section(msg('sec.jwt.section.7')),
      alignRows([
        [msg('common.label.result'), verifyResult],
        [msg('sec.jwt.row.9'), verifyMethod],
        [msg('common.label.secret'), secret ? (secret.includes('BEGIN') || secret.trimStart().startsWith('{') ? msg('sec.jwt.row.10') : msg('sec.jwt.row.11', { secret: secret.length })) : msg('sec.jwt.section.8')],
      ]),
      section(msg('common.section.notes')),
      [
        msg('sec.jwt.row.12'),
        msg('sec.jwt.row.13'),
        msg('sec.jwt.row.14'),
        msg('sec.jwt.row.15'),
        msg('sec.jwt.row.16'),
      ].join('\n'),
    ];
    await emitText(ctx, 'jwt.txt', joinBlocks(blocks));
    ctx.report({ percent: 100, phase: 'done' });
    const status = !verifyRequested ? 'decoded' : verifyResult.startsWith('✓') && !expired && !notYetValid ? 'valid' : expired ? 'expired' : notYetValid ? 'not-yet-valid' : 'invalid-signature';
    return { extra: { alg: headerAlg, status, claims: Object.keys(claims).length, expired: expired ? 'yes' : 'no', notYetValid: notYetValid ? 'yes' : 'no', verify: verifyResult } };
  },
};

function parseJsonRecord(msg: Msg, text: string, part: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(msg('sec.parseJsonRecord.text.1'));
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw bad(msg, 'token', msg('sec.parseJsonRecord.reason.1', { part: part, message: (error as Error).message }), `{"alg":"HS256"}`);
  }
}

/* ── AES ───────────────────────────────────────────────────────────────────── */

function scryptCost(iterations: number): number {
  return 2 ** clamp(Math.floor(Math.log2(Math.max(iterations, 1))), 14, 16);
}

function deriveKey(kdf: Kdf, passphrase: string, salt: Uint8Array, keyLength: number, iterations: number): Uint8Array {
  if (kdf === 'scrypt') {
    const N = scryptCost(iterations);
    return new Uint8Array(scryptSync(passphrase, buf(salt), keyLength, { N, r: 8, p: 1, maxmem: 512 * 1024 * 1024 }));
  }
  return new Uint8Array(pbkdf2Sync(passphrase, buf(salt), iterations, keyLength, 'sha256'));
}

function keyLengthOf(cipher: AesCipher): number {
  return cipher === 'aes-128-cbc' ? 16 : 32;
}

function ivLengthOf(cipher: AesCipher): number {
  return cipher === 'aes-256-gcm' ? 12 : 16;
}

function buildContainer(fields: { kdf: Kdf; cipher: AesCipher; iterations: number; salt: Uint8Array; iv: Uint8Array; tag: Uint8Array; data: Uint8Array }): Uint8Array {
  const header = Buffer.alloc(7);
  header.writeUInt8(1, 0);
  header.writeUInt8(KDF_IDS[fields.kdf], 1);
  header.writeUInt8(CIPHER_CODES[fields.cipher], 2);
  header.writeUInt32BE(clamp(fields.iterations, 1, 4294967295), 3);
  const parts = [header, Uint8Array.from([fields.salt.length, ...fields.salt]), Uint8Array.from([fields.iv.length, ...fields.iv]), Uint8Array.from([fields.tag.length, ...fields.tag]), fields.data];
  const total = parts.reduce((sum, item) => sum + item.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function readContainer(msg: Msg, bytes: Uint8Array): { kdf: Kdf; cipher: AesCipher; iterations: number; salt: Uint8Array; iv: Uint8Array; tag: Uint8Array; data: Uint8Array } {
  if (bytes.length < 7) throw bad(msg, 'input', msg('sec.readContainer.reason.1'), msg('sec.parseContainer.reason.1'));
  if (bytes[0] !== 1) throw bad(msg, 'input', msg('sec.readContainer.reason.2', { bytes: String(bytes[0]) }), msg('sec.parseContainer.reason.1'));
  const kdfId = bytes[1];
  const cipherId = bytes[2];
  const cipher = CIPHER_IDS[cipherId ?? 0];
  if (!cipher) throw bad(msg, 'input', msg('sec.readContainer.reason.3', { cipherId: String(cipherId) }), msg('sec.parseContainer.reason.1'));
  const iterations = Buffer.from(buf(bytes.slice(0, 7))).readUInt32BE(3);
  let offset = 7;
  const field = (name: string, max: number): Uint8Array => {
    const length = bytes[offset] ?? 0;
    offset += 1;
    if (length > max || offset + length > bytes.length) throw bad(msg, 'input', msg('sec.readContainer.reason.4', { name: name }), msg('sec.parseContainer.reason.1'));
    const value = bytes.slice(offset, offset + length);
    offset += length;
    return value;
  };
  const salt = field('salt', 64);
  const iv = field('iv', 32);
  const tag = field('authTag', 32);
  if (salt.length !== 16) throw bad(msg, 'input', msg('sec.readContainer.reason.5', { salt: salt.length }), msg('sec.parseContainer.reason.1'));
  if (iv.length !== ivLengthOf(cipher)) throw bad(msg, 'input', msg('sec.readContainer.reason.6', { cipher: ivLengthOf(cipher), iv: iv.length }), msg('sec.parseContainer.reason.1'));
  if (cipher === 'aes-256-gcm' && tag.length !== 16) throw bad(msg, 'input', msg('sec.readContainer.reason.7', { tag: tag.length }), msg('sec.parseContainer.reason.1'));
  return {
    kdf: kdfId === KDF_IDS.pbkdf2 ? 'pbkdf2' : 'scrypt',
    cipher,
    iterations: iterations || 150000,
    salt,
    iv,
    tag,
    data: bytes.slice(offset),
  };
}

function renderContainer(bytes: Uint8Array, format: AesFormat): string {
  const source = buf(bytes);
  if (format === 'hex') return source.toString('hex');
  if (format === 'base64url') return source.toString('base64url');
  return source.toString('base64');
}

function parseContainer(msg: Msg, raw: string, format: AesFormat): Uint8Array {
  const compact = raw.replace(/\s/g, '');
  if (format === 'hex') {
    if (!/^(?:[0-9a-fA-F]{2})+$/.test(compact)) throw bad(msg, 'input', msg('sec.parseContainer.reason.2'), msg('sec.parseContainer.reason.3'));
    return new Uint8Array(Buffer.from(compact, 'hex'));
  }
  const urlSafe = compact.replace(/-/g, '+').replace(/_/g, '/');
  const padded = urlSafe.padEnd(Math.ceil(urlSafe.length / 4) * 4, '=');
  if (!/^[A-Za-z0-9+/=]+$/.test(padded)) throw bad(msg, 'input', msg('sec.parseContainer.reason.4'), msg('sec.parseContainer.reason.1'));
  const decoded = Buffer.from(padded, 'base64');
  if (!decoded.length) throw bad(msg, 'input', msg('sec.decodeBase32.reason.1'), msg('sec.parseContainer.reason.1'));
  return new Uint8Array(decoded);
}

const aesTool: ToolImpl = {
  id: 'aes',
  async run(ctx): Promise<ToolResult> {
    const msg = makeMsg(localeOf(ctx));
    const input = need(msg, ctx, 'input', msg('sec.aes.reason.1'), msg('sec.aes.reason.2'));
    const mode = optSelect(ctx, 'mode', ['encrypt', 'decrypt'] as const, 'encrypt');
    const format = optSelect(ctx, 'format', AES_FORMATS, 'base64');
    const passphrase = rawOption(ctx, 'passphrase');
    if (!passphrase) throw bad(msg, 'passphrase', msg('sec.aes.reason.3'), 'correct horse battery staple');
    const cipher = optSelect(ctx, 'cipher', AES_CIPHERS, 'aes-256-gcm');
    const kdf = optSelect(ctx, 'kdf', KDF_NAMES, 'scrypt');
    const iterations = clamp(Math.round(optNum(ctx, 'iterations', 150000)), 1000, 2_000_000);

    if (mode === 'encrypt') {
      const salt = new Uint8Array(randomBytes(16));
      const iv = new Uint8Array(randomBytes(ivLengthOf(cipher)));
      const key = deriveKey(kdf, passphrase, salt, keyLengthOf(cipher), iterations);
      const gcm = cipher === 'aes-256-gcm';
      ctx.report({ percent: 55, phase: 'cipher' });
      const handle = makeHandle('encrypt', cipher, buf(key), buf(iv), gcm ? 16 : 0);
      const plain = Buffer.from(input, 'utf8');
      const data = new Uint8Array(Buffer.concat([buf(handle.update(plain)), buf(handle.final())]));
      const tag = gcm ? new Uint8Array(handle.getAuthTag()) : new Uint8Array(0);
      const container = buildContainer({ kdf, cipher, iterations, salt, iv, tag, data });
      const rendered = renderContainer(container, format);
      const blocks = [
        section(msg('sec.aes.section.3')),
        rendered,
        section(msg('sec.aes.section.1', { cipher: cipher, kdf: kdf, format: format })),
        alignRows([
          [msg('sec.rsa.section.1'), msg('sec.aes.row.1', { plain: plain.length })],
          [msg('sec.aes.row.2'), msg('sec.aes.row.3', { data: data.length })],
          [msg('sec.aes.row.4'), msg('sec.aes.row.5', { container: container.length, rendered: rendered.length })],
          ['salt', msg('sec.aes.row.6', { salt: hexOf(salt) })],
          ['IV/nonce', msg('sec.aes.row.7', { iv: hexOf(iv), iv2: iv.length })],
          ['authTag', gcm ? msg('sec.aes.row.8', { tag: hexOf(tag) }) : msg('sec.aes.row.9')],
          [msg('sec.aes.row.10'), kdf === 'scrypt' ? msg('sec.aes.row.11', { iterations: scryptCost(iterations), iterations2: iterations }) : msg('sec.aes.section.2', { iterations: iterations })],
        ]),
        section(msg('sec.aes.section.4')),
        msg(CONTAINER_LAYOUT) + '\n  ' + msg(CONTAINER_ALG_IDS) + msg('sec.aes.row.12'),
        section(msg('common.section.notes')),
        [
          msg('sec.aes.row.13'),
          msg('sec.aes.row.14'),
          msg('sec.aes.row.15'),
          msg('sec.aes.row.16'),
        ].join('\n'),
      ];
      await emitText(ctx, 'aes.txt', joinBlocks(blocks));
      ctx.report({ percent: 100, phase: 'done' });
      return { extra: { mode, cipher, kdf, iterations, encoding: format, containerBytes: container.length, container: rendered } };
    }

    const containerBytes = parseContainer(msg, input, format);
    const packed = readContainer(msg, containerBytes);
    const key = deriveKey(packed.kdf, passphrase, packed.salt, keyLengthOf(packed.cipher), packed.iterations);
    ctx.report({ percent: 55, phase: 'cipher' });
    const gcm = packed.cipher === 'aes-256-gcm';
    let plain: Buffer;
    try {
      const handle = makeHandle('decrypt', packed.cipher, buf(key), buf(packed.iv), gcm ? packed.tag.length || 16 : 0);
      if (gcm) handle.setAuthTag(buf(packed.tag));
      plain = Buffer.concat([buf(handle.update(buf(packed.data))), buf(handle.final())]);
    } catch (error) {
      const reason = gcm
        ? msg('sec.aes.text.1')
        : msg('sec.aes.text.2', { cipher: packed.cipher });
      const blocks = [
        section(msg('sec.aes.section.5', { cipher: packed.cipher, kdf: packed.kdf })),
        alignRows([
          [msg('sec.aes.row.17'), msg('sec.aes.row.18', { containerBytes: containerBytes.length })],
          [msg('sec.aes.row.19'), msg('sec.aes.rowx.1', { cipher: CIPHER_CODES[packed.cipher], cipher2: packed.cipher })],
          ['salt/IV/tag', `${hexOf(packed.salt)} / ${hexOf(packed.iv)} / ${packed.tag.length ? hexOf(packed.tag) : msg('common.value.none')}`],
          [msg('sec.rsa.row.1'), msg('sec.aes.row.3', { data: packed.data.length })],
          [msg('sec.aes.section.6'), (error as Error).message],
        ]),
        section(msg('sec.aes.section.7')),
        `✗ ${reason}`,
        section(msg('common.section.notes')),
        msg('sec.aes.row.20'),
      ];
      await emitText(ctx, 'aes.txt', joinBlocks(blocks));
      ctx.report({ percent: 100, phase: 'done' });
      return { extra: { mode, cipher: packed.cipher, ok: 'no', reason } };
    }
    const text = utf8(plain);
    const roundTrip = Buffer.from(text, 'utf8').equals(plain);
    if (!roundTrip && gcm) {
      const blocks = [
        section(msg('sec.aes.section.8', { cipher: packed.cipher })),
        alignRows([
          [msg('sec.rsa.row.1'), msg('sec.aes.row.3', { data: packed.data.length })],
          [msg('sec.aes.row.21'), msg('sec.rsa.row.2', { plain: plain.length })],
          [msg('sec.rsa.section.2'), msg('sec.aes.row.22')],
          [msg('sec.aes.section.9'), hexOf(plain)],
        ]),
        section(msg('common.section.notes')),
        msg('sec.aes.row.23'),
      ];
      await emitText(ctx, 'aes.txt', joinBlocks(blocks));
      ctx.report({ percent: 100, phase: 'done' });
      return { extra: { mode, cipher: packed.cipher, ok: 'partial', hex: hexOf(plain) } };
    }
    const blocks = [
      section(msg('sec.aes.section.10', { cipher: packed.cipher, kdf: packed.kdf })),
      section(msg('common.label.result')),
      text,
      alignRows([
        [msg('sec.aes.row.17'), msg('sec.aes.row.18', { containerBytes: containerBytes.length })],
        [msg('sec.rsa.row.1'), msg('sec.aes.row.3', { data: packed.data.length })],
        [msg('sec.rsa.row.3'), msg('sec.rsa.row.2', { plain: plain.length })],
        [msg('sec.aes.row.24'), `${packed.cipher} · ${packed.kdf} · iterations=${packed.iterations}`],
        ['authTag', gcm ? msg('sec.aes.row.25', { tag: hexOf(packed.tag) }) : msg('sec.aes.row.26')],
        [msg('sec.aes.row.27'), roundTrip ? msg('sec.aes.row.28') : msg('sec.aes.row.29', { text: text.length, plain: hexOf(plain).slice(0, 64) })],
      ]),
      section(msg('common.section.notes')),
      [
        msg('sec.aes.row.30'),
        msg('sec.aes.row.31'),
        gcm ? msg('sec.aes.row.32') : msg('sec.aes.row.33'),
      ].join('\n'),
    ];
    await emitText(ctx, 'aes.txt', joinBlocks(blocks));
    ctx.report({ percent: 100, phase: 'done' });
    return { extra: { mode, cipher: packed.cipher, kdf: packed.kdf, ok: 'yes', bytes: plain.length, text } };
  },
};

/* ── RSA ───────────────────────────────────────────────────────────────────── */

const SIGN_HEADER = /^signature\s*[:=]\s*(\S+)\s*\n([\s\S]*)$/i;

const rsaTool: ToolImpl = {
  id: 'rsa',
  async run(ctx): Promise<ToolResult> {
    const msg = makeMsg(localeOf(ctx));
    const mode = optSelect(ctx, 'mode', RSA_MODES, 'generate');
    const bits = clamp(Math.round(Number(ctx.options.bits) || 2048), 1024, 8192);
    const format = optSelect(ctx, 'format', ['pem', 'jwk'] as const, 'pem');
    const passphrase = rawOption(ctx, 'passphrase');
    const padding = optSelect(ctx, 'padding', ['oaep', 'pkcs1'] as const, 'oaep');
    const hash = optSelect(ctx, 'hash', ['sha256', 'sha512'] as const, 'sha256');
    const digestName = hash === 'sha256' ? 'SHA256' : 'SHA512';

    if (mode === 'generate') {
      ctx.report({ percent: 25, phase: 'keygen' });
      const pair = passphrase
        ? generateKeyPairSync('rsa', {
            modulusLength: bits,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase },
          })
        : generateKeyPairSync('rsa', {
            modulusLength: bits,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
          });
      const privatePem = String(pair.privateKey);
      const publicPem = String(pair.publicKey);
      const privateHandle = createPrivateKey({ key: privatePem, format: 'pem', type: 'pkcs8', passphrase: passphrase || undefined });
      const publicHandle = createPublicKey({ key: publicPem, format: 'pem', type: 'spki' });
      const der = new Uint8Array(publicHandle.export({ type: 'spki', format: 'der' }) as Uint8Array);
      ctx.report({ percent: 85, phase: 'render' });
      const blocks = [
        section(msg('sec.rsa.section.3', { bits: bits, format: format.toUpperCase() })),
        alignRows([
          [msg('sec.rsa.row.4'), `${privateHandle.asymmetricKeyType} · ${Number(privateHandle.asymmetricKeyDetails?.modulusLength ?? 0)} bit`],
          [msg('sec.rsa.row.5'), passphrase ? msg('sec.rsa.row.6') : msg('sec.rsa.row.7')],
          [msg('sec.rsa.row.8'), 'SPKI'],
          [msg('sec.rsa.section.4'), groupedFingerprint(der, 'sha256')],
          [msg('sec.rsa.row.9'), groupedFingerprint(der, 'sha1')],
          [msg('sec.rsa.row.10'), msg('sec.rsa.section.5', { bits: Math.floor(bits / 8) - 2 * 32 - 2 })],
          [msg('sec.rsa.row.11'), msg('sec.rsa.section.5', { bits: Math.floor(bits / 8) - 11 })],
        ]),
        section(msg('sec.rsa.section.6')),
        format === 'jwk' ? exportJwk(privateHandle, 'private') : privatePem,
        section(msg('sec.rsa.section.7')),
        format === 'jwk' ? exportJwk(publicHandle, 'public') : publicPem,
        section(msg('common.section.notes')),
        [
          msg('sec.rsa.row.12'),
          passphrase ? msg('sec.rsa.row.13') : msg('sec.rsa.row.14'),
          msg('sec.rsa.row.15'),
          msg('sec.rsa.row.16'),
        ].join('\n'),
      ];
      await emitText(ctx, 'rsa.txt', joinBlocks(blocks));
      ctx.report({ percent: 100, phase: 'done' });
      return { extra: { mode, bits, format, keyEncrypted: passphrase ? 'yes' : 'no', publicPem: publicPem.replace(/\n/g, '') } };
    }

    if (mode === 'pubkey') {
      const loaded = requirePrivate(msg, ctx, 'privateKey');
      const publicHandle = createPublicKey(loaded.keyObject);
      const publicText = format === 'jwk' ? exportJwk(publicHandle, 'public') : String(publicHandle.export({ type: 'spki', format: 'pem' }));
      const der = new Uint8Array(publicHandle.export({ type: 'spki', format: 'der' }) as Uint8Array);
      const blocks = [
        section(msg('sec.rsa.section.8')),
        alignRows([
          [msg('sec.rsa.row.17'), `${loaded.label}`],
          [msg('sec.summaryRows.row.1'), `${publicHandle.asymmetricKeyType} · ${Number(publicHandle.asymmetricKeyDetails?.modulusLength ?? 0)} bit`],
          [msg('sec.rsa.row.18'), format === 'jwk' ? msg('sec.rsa.row.19') : msg('sec.rsa.rowx.1')],
          [msg('sec.rsa.section.4'), groupedFingerprint(der, 'sha256')],
        ]),
        section(msg('sec.rsa.section.9')),
        publicText,
        section(msg('common.section.notes')),
        msg('sec.rsa.row.20'),
      ];
      await emitText(ctx, 'rsa.txt', joinBlocks(blocks));
      ctx.report({ percent: 100, phase: 'done' });
      return { extra: { mode, format, bits: Number(publicHandle.asymmetricKeyDetails?.modulusLength ?? 0), publicPem: String(publicText).replace(/\n/g, '').replace(/\s/g, '') } };
    }

    if (mode === 'encrypt' || mode === 'decrypt') {
      const message = need(msg, ctx, 'message', mode === 'encrypt' ? msg('sec.rsa.reason.1') : msg('sec.rsa.reason.2'), mode === 'encrypt' ? 'attack at dawn' : msg('sec.rsa.reason.3'));
      const blockBytes = Math.floor(bits / 8);
      const maxBytes = blockBytes - (padding === 'oaep' ? 2 * (hash === 'sha256' ? 32 : 64) + 2 : 11);
      if (mode === 'encrypt') {
        const loaded = requirePublic(msg, ctx, 'publicKey');
        const source = Buffer.from(message, 'utf8');
        if (source.length > maxBytes) throw bad(msg, 'message', msg('sec.rsa.reason.4', { source: source.length, padding: padding.toUpperCase(), digestName: digestName, maxBytes: maxBytes }), msg('sec.rsa.reason.5'));
        const options = padding === 'oaep' ? { key: loaded.keyObject, padding: nodeConstants.RSA_PKCS1_OAEP_PADDING, oaepHash: hash } : { key: loaded.keyObject, padding: nodeConstants.RSA_PKCS1_PADDING };
        const out = buf(publicEncrypt(options, source));
        const encoded = out.toString('base64');
        const blocks = [
          section(msg('sec.rsa.section.10', { padding: padding.toUpperCase(), digestName: digestName })),
          section(msg('common.label.result')),
          encoded,
          alignRows([
            [msg('common.label.secret'), `${loaded.label}${loaded.derived ? msg('sec.rsa.row.21') : ''}`],
            [msg('sec.rsa.row.3'), msg('sec.rsa.row.22', { source: source.length, maxBytes: maxBytes })],
            [msg('sec.rsa.row.1'), msg('sec.rsa.row.23', { out: out.length, blockBytes: blockBytes })],
            [msg('sec.rsa.section.11'), padding === 'oaep' ? msg('sec.rsa.sectionx.2', { digestName: digestName }) : 'PKCS#1 v1.5'],
          ]),
          section(msg('common.section.notes')),
          [
            msg('sec.rsa.row.24'),
            msg('sec.rsa.row.25'),
            msg('sec.rsa.row.26'),
          ].join('\n'),
        ];
        await emitText(ctx, 'rsa.txt', joinBlocks(blocks));
        ctx.report({ percent: 100, phase: 'done' });
        return { extra: { mode, padding, hash, bytes: out.length, cipher: encoded } };
      }
      const loaded = requirePrivate(msg, ctx, 'privateKey');
      const cipherBytes = Buffer.from(message.replace(/\s/g, ''), 'base64');
      if (!cipherBytes.length || cipherBytes.length !== blockBytes) {
        throw bad(msg, 'message', msg('sec.rsa.reason.6', { blockBytes: blockBytes, bits: bits, cipherBytes: cipherBytes.length }), msg('sec.rsa.reason.7'));
      }
      let plain: Buffer;
      try {
        const options = padding === 'oaep' ? { key: loaded.keyObject, padding: nodeConstants.RSA_PKCS1_OAEP_PADDING, oaepHash: hash } : { key: loaded.keyObject, padding: nodeConstants.RSA_PKCS1_PADDING };
        plain = buf(privateDecrypt(options, cipherBytes));
      } catch (error) {
        throw new EngineError('bad_request', msg('sec.rsa.error.1', { message: (error as Error).message }));
      }
      const text = utf8(plain);
      if (!Buffer.from(text, 'utf8').equals(plain)) {
        throw new EngineError('bad_request', msg('sec.rsa.error.2', { plain: plain.length, plain2: hexOf(plain).slice(0, 64) }));
      }
      const blocks = [
        section(msg('sec.rsa.section.13', { padding: padding.toUpperCase(), digestName: digestName })),
        section(msg('common.label.result')),
        text,
        alignRows([
          [msg('common.label.secret'), loaded.label],
          [msg('sec.rsa.row.1'), msg('sec.rsa.row.27', { cipherBytes: cipherBytes.length })],
          [msg('sec.rsa.row.3'), msg('sec.rsa.row.2', { plain: plain.length })],
          [msg('sec.rsa.section.2'), msg('sec.rsa.section.14')],
        ]),
        section(msg('common.section.notes')),
        msg('sec.rsa.row.28'),
        msg('sec.rsa.row.29'),
      ];
      await emitText(ctx, 'rsa.txt', joinBlocks(blocks));
      ctx.report({ percent: 100, phase: 'done' });
      return { extra: { mode, padding, hash, bytes: plain.length, text } };
    }

    if (mode === 'sign') {
      const message = need(msg, ctx, 'message', msg('sec.rsa.reason.8'), 'attack at dawn');
      const loaded = requirePrivate(msg, ctx, 'privateKey');
      const source = Buffer.from(message, 'utf8');
      const signer = createSign(`RSA-${digestName}`);
      signer.update(source);
      const signature = buf(signer.sign(loaded.keyObject));
      const encoded = signature.toString('base64');
      const blocks = [
        section(msg('sec.rsa.section.15', { digestName: digestName })),
        section(msg('common.label.result')),
        encoded,
        alignRows([
          [msg('common.label.secret'), loaded.label],
          [msg('sec.rsa.row.30'), msg('sec.rsa.row.31', { source: source.length })],
          [msg('sec.rsa.row.32'), msg('sec.rsa.row.33', { signature: signature.length })],
          [msg('sec.rsa.section.11'), msg('sec.rsa.sectionx.1')],
        ]),
        section(msg('sec.rsa.section.17')),
        hexOf(signature),
        section(msg('sec.rsa.section.18')),
        `signature: ${encoded}\n${message}`,
        section(msg('common.section.notes')),
        [
          msg('sec.rsa.row.34'),
          msg('sec.rsa.row.35'),
          msg('sec.rsa.row.36'),
        ].join('\n'),
      ];
      await emitText(ctx, 'rsa.txt', joinBlocks(blocks));
      ctx.report({ percent: 100, phase: 'done' });
      return { extra: { mode, hash, bytes: signature.length, signature: encoded } };
    }

    const combined = need(msg, ctx, 'message', msg('sec.rsa.reason.9'), msg('sec.rsa.reason.10'));
    let signatureText = '';
    let content = '';
    const headerMatch = SIGN_HEADER.exec(combined);
    if (headerMatch) {
      signatureText = headerMatch[1]!;
      content = headerMatch[2]!;
    } else {
      const lines = combined.split('\n');
      const last = lines[lines.length - 1] ?? '';
      const expectedLength = 4 * Math.ceil(Math.floor(bits / 8) / 3);
      if (lines.length > 1 && /^[A-Za-z0-9+/]+={0,2}$/.test(last.trim()) && last.trim().length === expectedLength) {
        signatureText = last.trim();
        content = lines.slice(0, -1).join('\n');
      } else {
        throw bad(msg, 'message', msg('sec.rsa.reason.11'), 'signature: U3l4…\\nattack at dawn');
      }
    }
    const signatureBytes = Buffer.from(signatureText.replace(/\s/g, ''), 'base64');
    if (!signatureBytes.length) throw bad(msg, 'message', msg('sec.rsa.reason.12'), 'signature: <base64>');
    const loaded = requirePublic(msg, ctx, 'publicKey');
    const contentBytes = Buffer.from(content.replace(/\n$/, ''), 'utf8');
    const verifier = createVerify(`RSA-${digestName}`);
    verifier.update(contentBytes);
    let ok = false;
    try {
      ok = verifier.verify(loaded.keyObject, signatureBytes);
    } catch (error) {
      throw new EngineError('bad_request', msg('sec.rsa.error.3', { message: (error as Error).message }));
    }
    const blocks = [
      section(msg('sec.rsa.section.19', { digestName: digestName })),
      section(msg('common.label.result')),
      ok ? msg('sec.rsa.section.20') : msg('sec.rsa.section.21'),
      alignRows([
        [msg('common.label.secret'), `${loaded.label}${loaded.derived ? msg('sec.rsa.row.21') : ''}`],
        [msg('sec.rsa.row.37'), msg('sec.rsa.row.38', { contentBytes: contentBytes.length })],
        [msg('sec.rsa.row.32'), msg('sec.rsa.row.39', { signatureBytes: signatureBytes.length })],
        [msg('common.label.result'), ok ? msg('sec.rsa.section.20') : msg('sec.rsa.section.21')],
      ]),
      section(msg('sec.rsa.section.22')),
      content.replace(/\n$/, ''),
      section(msg('common.section.notes')),
      [
        msg('sec.rsa.row.40'),
        msg('sec.rsa.row.41', { row: content === combined ? msg('sec.rsa.row.42') : '' }),
        msg('sec.rsa.row.43'),
      ].join('\n'),
    ];
    await emitText(ctx, 'rsa.txt', joinBlocks(blocks));
    ctx.report({ percent: 100, phase: 'done' });
    return { extra: { mode, hash, ok: ok ? 'yes' : 'no', keyBytes: Math.floor(bits / 8) } };
  },
};

/* ── X509 ──────────────────────────────────────────────────────────────────── */

function parseDn(msg: Msg, raw: string): Row[] {
  const rows: Row[] = [];
  const protectedCommas = (raw ?? '').replace(/\\,/g, '\u0001');
  protectedCommas
    .split(',')
    .map((piece) => piece.trim().replace(/\u0001/g, ','))
    .filter((piece) => piece.length > 0)
    .forEach((piece, index) => {
      const eq = piece.indexOf('=');
      if (eq < 0) rows.push([msg('sec.parseDn.note.1', { p0: index + 1 }), piece]);
      else rows.push([`  ${piece.slice(0, eq).trim()}`, piece.slice(eq + 1).trim()]);
    });
  return rows.length ? rows : [[msg('sec.parseDn.label.1'), raw || msg('sec.readExtensions.text.1')]];
}

function sanEntries(msg: Msg, cert: X509Certificate): Row[] {
  const rows: Row[] = [];
  for (const entry of (cert.subjectAltName ?? '').split(',')) {
    const item = entry.trim();
    if (!item) continue;
    if (item.startsWith('DNS:')) rows.push(['  DNS', item.slice(4)]);
    else if (item.startsWith('IP Address:')) rows.push(['  IP', item.slice(11)]);
    else if (item.startsWith('email:')) rows.push(['  email', item.slice(6)]);
    else if (item.startsWith('URI:')) rows.push(['  URI', item.slice(4)]);
    else if (item.startsWith('DIRNAME:')) rows.push(['  DIRNAME', item.slice(8)]);
    else rows.push([msg('sec.sanEntries.note.1'), item]);
  }
  return rows;
}

const KEY_USAGE_BITS = ['sec.keyUsage.text.1', 'sec.keyUsage.text.2', 'sec.keyUsage.text.3', 'sec.keyUsage.text.4', 'sec.keyUsage.text.5', 'sec.keyUsage.text.6', 'sec.keyUsage.text.7', 'sec.keyUsage.text.8', 'sec.keyUsage.text.9'];
const EKU_NAMES: Record<string, string> = {
  '1.3.6.1.5.5.7.3.1': 'sec.eku.text.1',
  '1.3.6.1.5.5.7.3.2': 'sec.eku.text.2',
  '1.3.6.1.5.5.7.3.3': 'sec.eku.text.3',
  '1.3.6.1.5.5.7.3.4': 'sec.eku.text.4',
  '1.3.6.1.5.5.7.3.8': 'sec.eku.text.5',
  '1.3.6.1.5.5.7.3.9': 'sec.eku.text.6',
  '2.23.140.1.2.1': 'sec.eku.text.7',
  '2.23.140.1.2.2': 'sec.eku.text.8',
};

type DerNode = { tag: number; start: number; headerEnd: number; end: number; children: DerNode[] };

function readDer(bytes: Uint8Array, offset: number): { node: DerNode; next: number } | null {
  if (offset >= bytes.length) return null;
  const tag = bytes[offset]!;
  let cursor = offset + 1;
  const first = bytes[cursor] ?? 0xff;
  if (first === 0xff) return null;
  let length = first;
  if (first & 0x80) {
    const count = first & 0x7f;
    if (!count || cursor + count >= bytes.length) return null;
    length = 0;
    for (let i = 1; i <= count; i += 1) length = length * 256 + bytes[cursor + i]!;
    cursor += count + 1;
  } else {
    cursor += 1;
  }
  const end = cursor + length;
  if (end > bytes.length) return null;
  const node: DerNode = { tag, start: offset, headerEnd: cursor, end, children: [] };
  if (tag & 0x20) {
    let childCursor = cursor;
    while (childCursor < end) {
      const child = readDer(bytes, childCursor);
      if (!child) break;
      node.children.push(child.node);
      childCursor = child.next;
    }
  }
  return { node, next: end };
}

function derBytes(bytes: Uint8Array, node: DerNode): Uint8Array {
  return bytes.slice(node.headerEnd, node.end);
}

function oidText(bytes: Uint8Array): string {
  const values = Array.from(bytes);
  if (!values.length) return '';
  let text = `${Math.floor(values[0]! / 40)}.${values[0]! % 40}`;
  let accumulator = 0;
  for (const byte of values.slice(1)) {
    accumulator = (accumulator << 7) | (byte & 0x7f);
    if (!(byte & 0x80)) {
      text += `.${accumulator}`;
      accumulator = 0;
    }
  }
  return text;
}

type CertExtensions = {
  readonly version: string;
  readonly basicConstraints: string;
  readonly keyUsage: string;
  readonly extKeyUsage: string;
  readonly subjectKeyId: string;
  readonly authorityKeyId: string;
  readonly critical: string;
};

const NO_EXTENSIONS: CertExtensions = { version: 'common.value.unknown', basicConstraints: 'sec.x509.row.1', keyUsage: 'sec.x509.row.1', extKeyUsage: 'sec.x509.row.1', subjectKeyId: 'common.value.none', authorityKeyId: 'common.value.none', critical: '—' };

function noExtensions(msg: Msg): CertExtensions {
  return {
    version: msg(NO_EXTENSIONS.version),
    basicConstraints: msg(NO_EXTENSIONS.basicConstraints),
    keyUsage: msg(NO_EXTENSIONS.keyUsage),
    extKeyUsage: msg(NO_EXTENSIONS.extKeyUsage),
    subjectKeyId: msg(NO_EXTENSIONS.subjectKeyId),
    authorityKeyId: msg(NO_EXTENSIONS.authorityKeyId),
    critical: NO_EXTENSIONS.critical,
  };
}

function collectExtensions(der: Uint8Array, node: DerNode, found: Map<string, { value: DerNode; critical: boolean }>): void {
  if (node.tag === 0x30 && node.children.length >= 2) {
    const [oidNode, second] = node.children as [DerNode, DerNode];
    if (oidNode.tag === 0x06) {
      const oid = oidText(derBytes(der, oidNode));
      if (second.tag === 0x04) found.set(oid, { value: second, critical: false });
      else if (second.tag === 0x01 && node.children[2]?.tag === 0x04) found.set(oid, { value: node.children[2]!, critical: true });
    }
  }
  for (const child of node.children) collectExtensions(der, child, found);
}

function readExtensions(msg: Msg, pemBlock: string): CertExtensions {
  const body = pemBlock.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  const der = new Uint8Array(Buffer.from(body, 'base64'));
  if (der.length < 16) return noExtensions(msg);
  const root = readDer(der, 0);
  if (!root) return noExtensions(msg);
  const found = new Map<string, { value: DerNode; critical: boolean }>();
  collectExtensions(der, root.node, found);
  const inner = (oid: string): DerNode | null => found.get(oid)?.value ?? null;
  const versionMatch = /a0030201([0-9a-f]{2})/.exec(hexOf(der).slice(0, 60));
  const basic = inner('2.5.29.19');
  let basicText = msg('sec.x509.row.1');
  if (basic) {
    const basicInner = derBytes(der, basic);
    const content = readDer(basicInner, 0)?.node;
    const ca = content?.children.some((child) => child.tag === 0x01 && basicInner[child.headerEnd] !== 0) ?? false;
    const pathLenNode = content?.children.find((child) => child.tag === 0x02);
    const pathLenBytes = pathLenNode ? basicInner.slice(pathLenNode.headerEnd, pathLenNode.end) : null;
    const pathLen = pathLenBytes && pathLenBytes.length ? Number(pathLenBytes[pathLenBytes.length - 1]) : null;
    basicText = `${ca ? 'CA:TRUE' : 'CA:FALSE'}${pathLen === null ? '' : `, pathlen:${pathLen}`}${found.get('2.5.29.19')!.critical ? ' · critical' : ''}`;
  }
  const usage = inner('2.5.29.15');
  let usageText = msg('sec.x509.row.1');
  if (usage) {
    const usageInner = derBytes(der, usage);
    const bitString = readDer(usageInner, 0)?.node;
    const raw = bitString ? usageInner.slice(bitString.headerEnd, bitString.end) : new Uint8Array(0);
    if (raw.length >= 2) {
      const unused = raw[0]!;
      const bits: string[] = [];
      const payload = Array.from(raw.slice(1));
      payload.forEach((byte, byteIndex) => {
        for (let bit = 0; bit < 8; bit += 1) {
          const position = byteIndex * 8 + bit;
          const limit = payload.length * 8 - unused;
          if (position >= limit) continue;
          if (byte & (0x80 >>> bit)) bits.push(msg(KEY_USAGE_BITS[position] ?? `bit ${position}`));
        }
      });
      usageText = `${bits.join(msg('common.list.sep')) || msg('sec.readExtensions.text.2')}${found.get('2.5.29.15')!.critical ? ' · critical' : ''}`;
    }
  }
  const eku = inner('2.5.29.37');
  let ekuText = msg('sec.x509.row.1');
  if (eku) {
    const ekuInner = derBytes(der, eku);
    const sequence = readDer(ekuInner, 0)?.node;
    const names = (sequence?.children ?? []).filter((child) => child.tag === 0x06).map((child) => {
      const oid = oidText(ekuInner.slice(child.headerEnd, child.end));
      return msg(EKU_NAMES[oid] ?? oid);
    });
    ekuText = names.length ? names.join(msg('common.list.sep')) : msg('sec.readExtensions.text.1');
  }
  const keyIdText = (oid: string): string => {
    const node = inner(oid);
    if (!node) return msg('common.value.none');
    const content = derBytes(der, node);
    const wrapper = readDer(content, 0)?.node;
    if (!wrapper) return hexOf(content).toUpperCase();
    if (wrapper.tag === 0x30) {
      const inner = wrapper.children.find((child) => child.tag === 0x80 || child.tag === 0x04) ?? wrapper.children[0];
      return inner ? hexOf(content.slice(inner.headerEnd, inner.end)).toUpperCase() : hexOf(content).toUpperCase();
    }
    return hexOf(content.slice(wrapper.headerEnd, wrapper.end)).toUpperCase();
  };
  const criticalList = [...found.entries()].filter(([, entry]) => entry.critical).map(([oid]) => oid).join(msg('common.list.sep'));
  return {
    version: versionMatch ? `X.509 v${parseInt(versionMatch[1]!, 16) + 1}` : msg('common.value.unknown'),
    basicConstraints: basicText,
    keyUsage: usageText,
    extKeyUsage: ekuText,
    subjectKeyId: keyIdText('2.5.29.14'),
    authorityKeyId: keyIdText('2.5.29.35'),
    critical: criticalList || msg('common.value.none'),
  };
}

function extensionRows(msg: Msg, cert: X509Certificate, pemBlock: string): Row[] {
  const extensions = readExtensions(msg, pemBlock);
  const rawInfoAccess = (cert as unknown as { infoAccess?: string | string[] }).infoAccess;
  const infoAccess = typeof rawInfoAccess === 'string' ? rawInfoAccess.split(/\r?\n/).filter(Boolean) : rawInfoAccess ?? [];
  const caFromBasic = /CA:TRUE/i.test(extensions.basicConstraints);
  return [
    [msg('sec.extensionRows.row.2'), extensions.version],
    [msg('sec.extensionRows.row.3'), String((cert as unknown as { signatureAlgorithm?: string }).signatureAlgorithm ?? msg('common.value.unknown'))],
    [msg('sec.extensionRows.row.4'), String((cert as unknown as { signatureAlgorithmOid?: string }).signatureAlgorithmOid ?? msg('common.value.unknown'))],
    ['basicConstraints', extensions.basicConstraints],
    [msg('sec.extensionRows.row.5'), msg('sec.extensionRows.row.6', { row: caFromBasic ? msg('sec.extensionRows.row.7') : msg('sec.extensionRows.row.8'), ca: String(cert.ca) })],
    ['keyUsage', extensions.keyUsage],
    ['extendedKeyUsage', extensions.extKeyUsage],
    ['subjectKeyIdentifier', extensions.subjectKeyId],
    ['authorityKeyIdentifier', extensions.authorityKeyId],
    [msg('sec.extensionRows.row.9'), extensions.critical],
    [msg('sec.extensionRows.row.10'), String(sanEntries(msg, cert).length)],
    [msg('sec.extensionRows.rowx.1'), infoAccess.length ? infoAccess.join(' · ') : msg('common.value.none')],
  ];
}

function validityRows(msg: Msg, uiLocale: MsgLocale, cert: X509Certificate): Row[] {
  const notBefore = Date.parse(cert.validFrom);
  const notAfter = Date.parse(cert.validTo);
  const now = Date.now();
  const remainingDays = (notAfter - now) / DAY_MS;
  const totalDays = (notAfter - notBefore) / DAY_MS;
  const offsetMinutes = -new Date().getTimezoneOffset();
  const zone = `UTC${offsetMinutes >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, '0')}:${String(Math.abs(offsetMinutes) % 60).padStart(2, '0')}`;
  return [
    ['notBefore', msg('sec.validityRows.row.2', { notBefore: localTime(uiLocale, notBefore), zone: zone, toISOString: new Date(notBefore).toISOString() })],
    ['notAfter', msg('sec.validityRows.row.3', { notAfter: localTime(uiLocale, notAfter), zone: zone, toISOString: new Date(notAfter).toISOString() })],
    [msg('sec.validityRows.row.4'), msg('sec.validityRows.row.5', { row: remainingDays >= 0 ? msg('sec.validityRows.row.6') : msg('sec.validityRows.row.7'), remainingDays: Math.abs(remainingDays).toFixed(2), now: agoText(uiLocale, notAfter - now) })],
    [msg('sec.validityRows.row.8'), msg('sec.validityRows.row.9', { totalDays: totalDays.toFixed(2), row: totalDays > 398 ? msg('sec.validityRows.row.10') : msg('sec.validityRows.row.11') })],
    [msg('sec.validityRows.row.12'), now < notBefore ? msg('sec.validityRows.row.13') : now > notAfter ? msg('sec.validityRows.row.14') : msg('sec.validityRows.row.1')],
  ];
}

function summaryRows(msg: Msg, cert: X509Certificate, pemBlock: string): Row[] {
  const publicKey = cert.publicKey;
  const details = publicKey.asymmetricKeyDetails ?? {};
  const algorithm = publicKey.asymmetricKeyType ?? msg('common.value.unknown');
  const size = Number((details as { modulusLength?: number; divisorLength?: number }).modulusLength ?? (details as { divisorLength?: number }).divisorLength ?? 0);
  const curve = String((details as { namedCurve?: string }).namedCurve ?? '');
  const spki = new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }) as Uint8Array);
  const der = new Uint8Array(Buffer.from(pemBlock.replace(/-----[^-]+-----/g, '').replace(/\s/g, ''), 'base64'));
  return [
    [msg('sec.summaryRows.row.2'), cert.serialNumber],
    [msg('sec.summaryRows.row.3'), BigInt(`0x${cert.serialNumber.replace(/[:\s]/g, '') || '0'}`).toString()],
    [msg('sec.summaryRows.row.1'), `${algorithm}${size ? ` · ${size} bit` : ''}${curve ? msg('sec.summaryRows.row.4', { curve: curve }) : ''}`],
    [msg('sec.summaryRows.row.5'), msg('sec.summaryRows.row.6', { der: der.length })],
    [msg('sec.summaryRows.row.7'), groupedFingerprint(spki, 'sha256')],
    [msg('sec.summaryRows.row.8'), cert.fingerprint],
    [msg('sec.summaryRows.row.9'), cert.fingerprint256],
    [msg('sec.summaryRows.row.10'), cert.fingerprint512],
  ];
}

function jsonOf(msg: Msg, cert: X509Certificate, pemBlock: string): Record<string, unknown> {
  const extensions = readExtensions(msg, pemBlock);
  const san = sanEntries(msg, cert);
  const notBefore = Date.parse(cert.validFrom);
  const notAfter = Date.parse(cert.validTo);
  return {
    subject: cert.subject,
    issuer: cert.issuer,
    serialNumber: cert.serialNumber,
    version: extensions.version,
    signatureAlgorithm: String((cert as unknown as { signatureAlgorithm?: string }).signatureAlgorithm ?? ''),
    subjectAltName: Object.fromEntries(san.map((entry, index) => [`${entry[0].trim()}${entry[0].trim() === msg('sec.jsonOf.text.1') ? index + 1 : ''}`, entry[1]])),
    validFrom: cert.validFrom,
    validTo: cert.validTo,
    validityIso: { notBefore: new Date(notBefore).toISOString(), notAfter: new Date(notAfter).toISOString() },
    remainingDays: Number(((notAfter - Date.now()) / DAY_MS).toFixed(4)),
    expired: Date.now() > notAfter,
    ca: cert.ca,
    basicConstraints: extensions.basicConstraints,
    keyUsage: extensions.keyUsage,
    extendedKeyUsage: extensions.extKeyUsage,
    subjectKeyIdentifier: extensions.subjectKeyId,
    authorityKeyIdentifier: extensions.authorityKeyId,
    infoAccess: (cert as unknown as { infoAccess?: string | string[] }).infoAccess ?? [],
    fingerprintSha1: cert.fingerprint,
    fingerprintSha256: cert.fingerprint256,
    fingerprintSha512: cert.fingerprint512,
    publicKeyPem: String(cert.publicKey).trim(),
    pem: pemBlock,
  };
}

const x509Tool: ToolImpl = {
  id: 'x509',
  async run(ctx): Promise<ToolResult> {
    const uiLocale = localeOf(ctx);
    const msg = makeMsg(uiLocale);
    const warnings: string[] = [];
    const pem = need(msg, ctx, 'pem', msg('sec.x509.reason.1'), '-----BEGIN CERTIFICATE-----\\nMIID…');
    const chain = optBool(ctx, 'chain', false);
    const output = optSelect(ctx, 'output', ['summary', 'full-json'] as const, 'summary');
    if (/-----BEGIN (?:NEW )?CERTIFICATE REQUEST-----/.test(pem)) throw bad(msg, 'pem', msg('sec.x509.reason.2'), '-----BEGIN CERTIFICATE-----…');
    const blocks = pemBlocks(pem, 'CERTIFICATE');
    if (!blocks.length) throw bad(msg, 'pem', msg('sec.x509.reason.3'), '-----BEGIN CERTIFICATE-----…');
    ctx.report({ percent: 35, phase: 'parse' });
    const parsed: Array<{ cert: X509Certificate; block: string }> = [];
    blocks.forEach((block, index) => {
      try {
        parsed.push({ cert: new X509Certificate(normalizePem(msg, block)), block });
      } catch (error) {
        if (index === 0) throw bad(msg, 'pem', msg('sec.x509.reason.4', { message: (error as Error).message }), msg('sec.x509.reason.5'));
        warnings.push(msg('sec.x509.warn.1', { p0: index + 1, message: (error as Error).message }));
      }
    });
    if (!parsed.length) throw bad(msg, 'pem', msg('sec.x509.reason.6'), '-----BEGIN CERTIFICATE-----…');
    const shown = chain ? parsed : parsed.slice(0, 1);
    const primary = parsed[0]!.cert;
    const out: string[] = [];

    shown.forEach((item, index) => {
      const cert = item.cert;
      const san = sanEntries(msg, cert);
      const notAfter = Date.parse(cert.validTo);
      out.push(
        joinBlocks([
          section(msg('sec.x509.section.1', { p0: index + 1, parsed: parsed.length, section: index === 0 ? msg('sec.x509.section.2') : cert.issuer === cert.subject ? msg('sec.x509.section.3') : msg('sec.x509.section.4') })),
          alignRows(summaryRows(msg, cert, item.block)),
          section(msg('sec.x509.section.5')),
          alignRows(parseDn(msg, cert.subject)),
          section(msg('sec.x509.section.6')),
          alignRows(parseDn(msg, cert.issuer)),
          section(msg('sec.x509.section.7')),
          alignRows(validityRows(msg, uiLocale, cert)),
          section(msg('sec.x509.section.8')),
          san.length ? alignRows(san) : alignRows([[msg('sec.x509.section.9'), msg('sec.x509.section.10')]]),
          section(msg('sec.x509.section.11')),
          alignRows(extensionRows(msg, cert, item.block)),
          section(msg('sec.x509.section.12')),
          alignRows([
            [msg('sec.x509.row.2'), cert.issuer === cert.subject ? msg('sec.x509.row.3') : msg('common.value.no')],
            [msg('sec.x509.row.5'), /CA:TRUE/.test(readExtensions(msg, item.block).basicConstraints) ? msg('sec.x509.row.6') : msg('sec.x509.row.7', { FALSE: readExtensions(msg, item.block).basicConstraints === msg('sec.x509.row.1') ? msg('sec.x509.row.8') + cert.ca : 'CA:FALSE' })],
            [msg('sec.x509.row.9'), msg('sec.x509.row.10', { DAY_MS: ((notAfter - Date.now()) / DAY_MS).toFixed(2), now: agoText(uiLocale, notAfter - Date.now()) })],
            [msg('sec.x509.row.11'), index === 0 && parsed.length > 1 ? msg('sec.x509.row.12', { section: parsed[1]!.cert.issuer === cert.subject ? msg('sec.x509.row.13') : msg('sec.x509.section.13') }) : '—'],
          ]),
          ...(chain ? [section(msg('sec.x509.section.14')), item.block] : []),
        ]),
      );
    });

    if (output === 'full-json') {
      const payload = shown.map((item) => jsonOf(msg, item.cert, item.block));
      const json = JSON.stringify(payload.length === 1 ? payload[0] : payload, null, 2);
      await ctx.emit({ name: 'x509.json', kind: 'json', bytes: new TextEncoder().encode(`${json}\n`) });
      out.unshift(joinBlocks([section(msg('sec.x509.section.15')), msg('sec.x509.section.16', { payload: payload.length })]));
    }
    out.push(
      joinBlocks([
        section(msg('common.section.notes')),
        [
          msg('sec.x509.text.1'),
          msg('sec.x509.text.2'),
          msg('sec.x509.text.3'),
          msg('sec.x509.text.4'),
          chain ? msg('sec.x509.text.5', { parsed: parsed.length }) : msg('sec.x509.text.6', { parsed: parsed.length }),
          output === 'full-json' ? msg('sec.x509.text.7') : msg('sec.x509.text.8'),
        ].join('\n'),
      ]),
    );
    if (warnings.length) out.push(joinBlocks([section(msg('sec.password.section.1')), warnings.map((item) => `· ${item}`).join('\n')]));
    await emitText(ctx, 'x509.txt', out.join('\n\n'));
    ctx.report({ percent: 100, phase: 'done' });
    return {
      extra: {
        certs: shown.length,
        total: parsed.length,
        subject: primary.subject.replace(/\s+/g, ''),
        serial: primary.serialNumber,
        fingerprint256: primary.fingerprint256,
        expired: Date.now() > Date.parse(primary.validTo) ? 'yes' : 'no',
        output,
      },
    };
  },
};

export const cryptoPrimitivesTools: ToolImpl[] = [jwtTool, aesTool, rsaTool, x509Tool, ...embeddedCryptoPrimitiveTools];
