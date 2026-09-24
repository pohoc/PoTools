import { EngineError } from '../errors.ts';
import { localeOf, makeMsg } from '../lib/messages.ts';
import type { ToolContext, ToolImpl, ToolResult } from '../types.ts';
import { alignRows, emitText, joinBlocks, optBool, optNum, optSelect, optStr, phraseLocale, relativePhrase, section } from './time-core.ts';
import type { MsgLocale, Row } from './time-core.ts';

type Msg = ReturnType<typeof makeMsg>;
type JwtAlgorithm = 'hs256' | 'hs384' | 'hs512' | 'rs256' | 'es256';
type VerificationKey = { key: CryptoKey; label: string };

const HASHES: Record<JwtAlgorithm, 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512'> = {
  hs256: 'SHA-256', hs384: 'SHA-384', hs512: 'SHA-512', rs256: 'SHA-256', es256: 'SHA-256',
};

function bad(msg: Msg, field: string, reason: string, example: string): EngineError {
  return new EngineError('bad_request', msg('common.error.badField', { field, reason, example }));
}

function need(msg: Msg, ctx: ToolContext, key: string, label: string, example: string): string {
  const raw = optStr(ctx, key);
  if (!raw) throw bad(msg, key, msg('sec.need.reason.1', { label }), example);
  return raw;
}

function rawOption(ctx: ToolContext, key: string): string {
  const value = ctx.options[key];
  return value === undefined || value === null ? '' : String(value).replace(/\r\n/g, '\n').replace(/\s+$/, '');
}

function decodeBase64Url(msg: Msg, raw: string, field: string): Uint8Array {
  const cleaned = raw.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  if (!cleaned) throw bad(msg, field, msg('sec.b64urlDecode.reason.1'), 'eyJhbGciOiJIUzI1NiJ9');
  if (!/^[A-Za-z0-9_-]+$/.test(cleaned)) throw bad(msg, field, msg('sec.b64urlDecode.reason.2', { cleaned: cleaned.slice(0, 20) }), 'eyJhbGciOiJIUzI1NiJ9');
  try {
    const base64 = cleaned.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(cleaned.length / 4) * 4, '=');
    const binary = atob(base64);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw bad(msg, field, msg('sec.b64urlDecode.reason.2', { cleaned: cleaned.slice(0, 20) }), 'eyJhbGciOiJIUzI1NiJ9');
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function parseJsonRecord(msg: Msg, text: string, part: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(msg('sec.parseJsonRecord.text.1'));
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw bad(msg, 'token', msg('sec.parseJsonRecord.reason.1', { part, message: (error as Error).message }), '{"alg":"HS256"}');
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function base64Bytes(raw: string): Uint8Array {
  const clean = raw.replace(/\s/g, '');
  const binary = atob(clean);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

function epochText(uiLocale: MsgLocale, seconds: number): string {
  const date = new Date(seconds * 1000);
  return `${date.toLocaleString(phraseLocale(uiLocale, 'zh-CN'), { hour12: false })} · ${date.toISOString()} · T=${seconds}`;
}

function agoText(uiLocale: MsgLocale, deltaMs: number): string {
  return relativePhrase(deltaMs, phraseLocale(uiLocale, 'zh-CN'));
}

function extractJwks(input: string): JsonWebKey[] {
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

function publicJwk(source: JsonWebKey): JsonWebKey {
  const jwk = { ...source } as JsonWebKey & Record<string, unknown>;
  for (const field of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'key_ops', 'use', 'alg']) delete jwk[field];
  return jwk;
}

async function loadVerifyKeys(msg: Msg, input: string, algorithm: JwtAlgorithm): Promise<VerificationKey[]> {
  const keys: VerificationKey[] = [];
  const webAlgorithm: AlgorithmIdentifier | RsaHashedImportParams | EcKeyImportParams = algorithm === 'rs256'
    ? { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
    : { name: 'ECDSA', namedCurve: 'P-256' };

  const pemBlocks = [...input.matchAll(/-----BEGIN PUBLIC KEY-----([\s\S]*?)-----END PUBLIC KEY-----/g)];
  for (const match of pemBlocks) {
    try {
      const der = base64Bytes(match[1] ?? '');
      const key = await crypto.subtle.importKey('spki', toArrayBuffer(der), webAlgorithm, false, ['verify']);
      keys.push({ key, label: msg('sec.keyCandidates.note.1') });
    } catch {
      // Continue through concatenated PEM blocks like the Node key loader.
    }
  }

  if (!keys.length) {
    for (const jwk of extractJwks(input)) {
      const isPrivate = Boolean((jwk as Record<string, unknown>).d);
      const kty = String(jwk.kty).toUpperCase();
      const expectedType = algorithm === 'rs256' ? 'RSA' : 'EC';
      if (kty !== expectedType || (kty === 'EC' && jwk.crv !== 'P-256')) continue;
      try {
        const key = await crypto.subtle.importKey('jwk', publicJwk(jwk), webAlgorithm, false, ['verify']);
        keys.push({ key, label: `JWK ${kty}${msg(isPrivate ? 'sec.keyCandidates.note.5' : 'sec.keyCandidates.note.6')}` });
      } catch {
        // Match Node's key-candidate behavior: an unimportable JWK does not prevent trying later candidates.
      }
    }
  }

  const compact = input.trim().replace(/\s/g, '');
  if (!keys.length && !pemBlocks.length && compact.length > 32 && /^[A-Za-z0-9+/_=-]+$/.test(compact)) {
    try {
      const der = base64Bytes(compact.replace(/-/g, '+').replace(/_/g, '/'));
      const key = await crypto.subtle.importKey('spki', toArrayBuffer(der), webAlgorithm, false, ['verify']);
      keys.push({ key, label: msg('sec.keyCandidates.note.8') });
    } catch {
      // Report the same localized missing-key family below.
    }
  }

  if (!keys.length) {
    const example = algorithm === 'rs256' ? '-----BEGIN PUBLIC KEY-----…' : '-----BEGIN PUBLIC KEY-----…';
    throw bad(msg, 'secret', msg('sec.loadKey.reason.4', { field: 'secret' }), example);
  }
  return keys;
}

async function verifySignature(algorithm: JwtAlgorithm, key: CryptoKey | string, signingInput: Uint8Array, signature: Uint8Array): Promise<{ matched: boolean; expected?: Uint8Array }> {
  if (algorithm.startsWith('hs')) {
    const hash = HASHES[algorithm];
    const imported = await crypto.subtle.importKey('raw', toArrayBuffer(new TextEncoder().encode(String(key))), { name: 'HMAC', hash }, false, ['sign']);
    const expected = new Uint8Array(await crypto.subtle.sign('HMAC', imported, toArrayBuffer(signingInput)));
    return { matched: timingSafeEqual(signature, expected), expected };
  }
  if (typeof key === 'string') throw new Error('missing asymmetric verification key');
  const matched = algorithm === 'rs256'
    ? await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, toArrayBuffer(signature), toArrayBuffer(signingInput))
    : await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, toArrayBuffer(signature), toArrayBuffer(signingInput));
  return { matched };
}

export const embeddedJwtTool: ToolImpl = {
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
    const requested = optSelect(ctx, 'algorithm', ['auto', 'hs256', 'hs384', 'hs512', 'rs256', 'es256'] as const, 'auto');
    const leeway = Math.min(3600, Math.max(0, Math.round(optNum(ctx, 'leeway', 0))));

    const header = parseJsonRecord(msg, decodeUtf8(decodeBase64Url(msg, parts[0]!, 'token(header)')), 'header');
    const claims = parseJsonRecord(msg, decodeUtf8(decodeBase64Url(msg, parts[1]!, 'token(payload)')), 'payload');
    const signature = decodeBase64Url(msg, parts[2]!, 'token(signature)');
    ctx.report({ percent: 45, phase: 'decode' });

    const headerAlg = String(header.alg ?? msg('common.value.missing'));
    const resolved = (requested === 'auto' ? headerAlg : requested).toLowerCase() as JwtAlgorithm;
    if (!['hs256', 'hs384', 'hs512', 'rs256', 'es256'].includes(resolved)) {
      throw bad(msg, 'algorithm', msg('sec.jwt.reason.3', { headerAlg }), 'hs256');
    }
    const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
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
    timeline.push(['leeway', msg('sec.jwt.note.8', { leeway })]);
    timeline.push([msg('sec.jwt.note.9'), expired ? msg('sec.jwt.note.10') : notYetValid ? msg('sec.jwt.note.11') : exp === null ? msg('sec.jwt.note.12') : msg('sec.validityRows.row.1')]);

    let verifyResult = msg('sec.jwt.text.1');
    let verifyMethod = '—';
    if (verifyRequested) {
      if (!secret) {
        throw new EngineError('bad_request', msg('sec.jwt.error.1', { resolved: resolved.toUpperCase(), error: resolved.startsWith('hs') ? msg('sec.jwt.error.2') : msg('sec.jwt.error.3') }));
      }
      if (resolved.startsWith('hs')) {
        const result = await verifySignature(resolved, secret, signingInput, signature);
        verifyResult = result.matched ? msg('sec.jwt.text.2') : msg('sec.jwt.text.3');
        verifyMethod = msg('sec.jwt.text.4', { resolved: HASHES[resolved].replace('-', ''), expected: hexOf(result.expected!), signature: hexOf(signature) });
      } else {
        const keys = await loadVerifyKeys(msg, secret, resolved);
        const candidate = keys[0]!;
        let matched = false;
        let errorText = '';
        try {
          matched = (await verifySignature(resolved, candidate.key, signingInput, signature)).matched;
        } catch (error) {
          errorText = (error as Error).message;
        }
        if (errorText) verifyResult = msg('sec.jwt.text.5', { message: errorText });
        else verifyResult = matched ? msg('sec.jwt.text.2') : msg('sec.jwt.text.3');
        verifyMethod = `${resolved.toUpperCase()} · ${candidate.label}${resolved === 'es256' ? msg('sec.jwt.text.7') : ''} · crypto.verify`;
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
        [msg('sec.jwt.row.6'), msg('sec.jwt.row.7', { headerAlg, resolved: resolved.toUpperCase() })],
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
      [msg('sec.jwt.row.12'), msg('sec.jwt.row.13'), msg('sec.jwt.row.14'), msg('sec.jwt.row.15'), msg('sec.jwt.row.16')].join('\n'),
    ];
    await emitText(ctx, 'jwt.txt', joinBlocks(blocks));
    ctx.report({ percent: 100, phase: 'done' });
    const status = !verifyRequested ? 'decoded' : verifyResult.startsWith('✓') && !expired && !notYetValid ? 'valid' : expired ? 'expired' : notYetValid ? 'not-yet-valid' : 'invalid-signature';
    return { extra: { alg: headerAlg, status, claims: Object.keys(claims).length, expired: expired ? 'yes' : 'no', notYetValid: notYetValid ? 'yes' : 'no', verify: verifyResult } };
  },
};

export const embeddedCryptoJwtTools: ToolImpl[] = [embeddedJwtTool];
