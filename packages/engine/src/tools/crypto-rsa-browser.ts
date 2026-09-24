import { EngineError } from '../errors.ts';
import { localeOf, makeMsg } from '../lib/messages.ts';
import type { ToolImpl, ToolResult } from '../types.ts';
import forge from 'node-forge';
import { alignRows, emitText, joinBlocks, optSelect, optStr, section } from './time-core.ts';

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function pem(label: string, bytes: Uint8Array): string {
  const encoded = base64(bytes);
  return `-----BEGIN ${label}-----\n${(encoded.match(/.{1,64}/g) ?? []).join('\n')}\n-----END ${label}-----\n`;
}

function groupedFingerprint(bytes: Uint8Array, algorithm: 'SHA-1' | 'SHA-256'): Promise<string> {
  const input = bytes.slice().buffer as ArrayBuffer;
  return crypto.subtle.digest(algorithm, input).then((digest) =>
    Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('').replace(/(.{2})(?!$)/g, '$1:').toUpperCase(),
  );
}

function jwkText(key: JsonWebKey, type: 'public' | 'private'): string {
  const { kty, n, e, d, p, q, dp, dq, qi } = key;
  const material: JsonWebKey = { kty, n, e };
  if (type === 'private') Object.assign(material, { d, p, q, dp, dq, qi });
  return `${JSON.stringify({ ...material, alg: type === 'public' ? 'RS256' : 'PS256' }, null, 2)}\n`;
}

function bytesFromInteger(value: forge.jsbn.BigInteger): Uint8Array {
  let hexValue = value.toString(16);
  if (hexValue.length % 2) hexValue = `0${hexValue}`;
  while (hexValue.startsWith('00')) hexValue = hexValue.slice(2);
  return Uint8Array.from(hexValue.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
}

function integerFromBase64Url(value: string): forge.jsbn.BigInteger {
  const bytes = decodeBase64(value);
  return new forge.jsbn.BigInteger(hex(bytes) || '0', 16);
}

function integerToBase64Url(value: forge.jsbn.BigInteger): string {
  return base64(bytesFromInteger(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function forgePrivateJwk(key: forge.pki.rsa.PrivateKey): RsaJwk {
  return {
    kty: 'RSA', n: integerToBase64Url(key.n), e: integerToBase64Url(key.e),
    d: integerToBase64Url(key.d), p: integerToBase64Url(key.p), q: integerToBase64Url(key.q),
    dp: integerToBase64Url(key.dP), dq: integerToBase64Url(key.dQ), qi: integerToBase64Url(key.qInv),
  };
}

function forgePublicFromJwk(key: JsonWebKey): forge.pki.rsa.PublicKey {
  if (!key.n || !key.e) throw new Error('RSA JWK must contain n and e');
  return forge.pki.rsa.setPublicKey(integerFromBase64Url(key.n), integerFromBase64Url(key.e));
}

function forgePrivateFromJwk(key: JsonWebKey): forge.pki.rsa.PrivateKey {
  if (!key.n || !key.e || !key.d || !key.p || !key.q || !key.dp || !key.dq || !key.qi) {
    throw new Error('RSA private JWK must contain all CRT parameters');
  }
  return forge.pki.rsa.setPrivateKey(
    integerFromBase64Url(key.n), integerFromBase64Url(key.e), integerFromBase64Url(key.d),
    integerFromBase64Url(key.p), integerFromBase64Url(key.q), integerFromBase64Url(key.dp),
    integerFromBase64Url(key.dq), integerFromBase64Url(key.qi),
  );
}

function forgePrivateFromPem(input: string, passphrase: string): forge.pki.rsa.PrivateKey {
  try { return forge.pki.privateKeyFromPem(input); }
  catch {
    try {
      const encrypted = forge.pki.encryptedPrivateKeyFromPem(input);
      return forge.pki.privateKeyFromAsn1(forge.pki.decryptPrivateKeyInfo(encrypted, passphrase));
    } catch {
      const legacy = forge.pki.decryptRsaPrivateKey(input, passphrase);
      if (legacy) return legacy;
      throw new Error('私钥无法解析或口令错误');
    }
  }
}

function forgeEncryptedPrivatePem(key: forge.pki.rsa.PrivateKey, passphrase: string): string {
  const rsaPrivateKey = forge.pki.privateKeyToAsn1(key);
  const privateKeyInfo = forge.pki.wrapRsaPrivateKey(rsaPrivateKey);
  const encrypted = forge.pki.encryptPrivateKeyInfo(privateKeyInfo, passphrase, { algorithm: 'aes256', prfAlgorithm: 'sha256' });
  return forge.pki.encryptedPrivateKeyToPem(encrypted);
}

function binaryString(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return binary;
}

type RsaJwk = JsonWebKey & { kty: 'RSA'; n: string; e: string; d?: string };
type RsaLoaded = { jwk: RsaJwk; label: string; derived: boolean; bits: number };
type RsaAlgorithm = 'oaep' | 'signature';
type RsaKeyKind = 'private' | 'public';

function bytesToBase64(bytes: Uint8Array): string {
  return base64(bytes);
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

function decodeBase64(value: string): Uint8Array {
  const normalized = value.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function derLength(length: number): Uint8Array {
  if (length < 0x80) return new Uint8Array([length]);
  const bytes: number[] = [];
  for (let value = length; value > 0; value = Math.floor(value / 256)) bytes.unshift(value & 0xff);
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function derTlv(tag: number, value: Uint8Array): Uint8Array {
  return new Uint8Array([tag, ...derLength(value.length), ...value]);
}

function derConcat(...values: Uint8Array[]): Uint8Array {
  const length = values.reduce((sum, value) => sum + value.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const value of values) { result.set(value, offset); offset += value.length; }
  return result;
}

const RSA_ALGORITHM_ID = derTlv(0x30, new Uint8Array([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]));

function pkcs1PublicToSpki(bytes: Uint8Array): Uint8Array {
  return derTlv(0x30, derConcat(RSA_ALGORITHM_ID, derTlv(0x03, derConcat(new Uint8Array([0]), bytes))));
}

function pkcs1PrivateToPkcs8(bytes: Uint8Array): Uint8Array {
  return derTlv(0x30, derConcat(new Uint8Array([0x02, 0x01, 0x00]), RSA_ALGORITHM_ID, derTlv(0x04, bytes)));
}

function pemBytes(input: string): Array<{ label: string; bytes: Uint8Array }> {
  return [...input.matchAll(/-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/g)].map((match) => ({
    label: match[1] ?? '',
    bytes: decodeBase64(match[2] ?? ''),
  }));
}

function jwkCandidates(input: string): JsonWebKey[] {
  const trimmed = input.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const source = Array.isArray(parsed) ? parsed : [((parsed as Record<string, unknown>)?.keys ?? parsed)];
    return source.filter((value): value is JsonWebKey => Boolean(value && typeof value === 'object' && (value as JsonWebKey).kty));
  } catch { return []; }
}

function keyImportAlgorithm(algorithm: RsaAlgorithm, hash: 'sha256' | 'sha512'): RsaHashedImportParams {
  return { name: algorithm === 'oaep' ? 'RSA-OAEP' : 'RSASSA-PKCS1-v1_5', hash: hash.toUpperCase().replace('SHA', 'SHA-') };
}

function cleanJwk(value: JsonWebKey): JsonWebKey {
  const { alg: _alg, key_ops: _keyOps, ext: _ext, use: _use, ...key } = value;
  return key;
}

function jwkIsPrivate(value: JsonWebKey): boolean {
  return typeof (value as Record<string, unknown>).d === 'string';
}

async function loadRsaKey(
  input: string,
  requested: RsaKeyKind,
  algorithm: RsaAlgorithm,
  hash: 'sha256' | 'sha512',
  msg: ReturnType<typeof makeMsg>,
  passphrase = '',
): Promise<RsaLoaded> {
  const importParams = keyImportAlgorithm(algorithm, hash);
  const privateUsage: KeyUsage[] = algorithm === 'oaep' ? ['decrypt'] : ['sign'];
  const publicUsage: KeyUsage[] = algorithm === 'oaep' ? ['encrypt'] : ['verify'];
  const failures: string[] = [];
  const candidates: Array<{ jwk?: JsonWebKey; der?: Uint8Array; format?: 'pkcs8' | 'spki'; label: string }> = [];
  const encryptedPrivate = /-----BEGIN ENCRYPTED PRIVATE KEY-----|Proc-Type:\s*4,ENCRYPTED/i.test(input);
  if (encryptedPrivate) {
    if (!passphrase) throw new EngineError('bad_request', msg('sec.loadKey.reason.1', { field: requested === 'private' ? 'privateKey' : 'publicKey' }));
    try {
      const key = forgePrivateFromPem(input, passphrase);
      candidates.push({ jwk: forgePrivateJwk(key), label: input.includes('ENCRYPTED PRIVATE KEY') ? 'PKCS#8 private key' : msg('sec.keyCandidates.note.3') });
    } catch (error) {
      throw new EngineError('bad_request', msg('sec.loadKey.reason.6', { field: requested === 'private' ? 'privateKey' : 'publicKey', reason: error instanceof Error ? error.message : String(error) }));
    }
  } else {
    for (const block of pemBytes(input)) {
      switch (block.label) {
        case 'PUBLIC KEY': candidates.push({ der: block.bytes, format: 'spki', label: 'sec.keyCandidates.note.1' }); break;
        case 'RSA PUBLIC KEY': candidates.push({ der: pkcs1PublicToSpki(block.bytes), format: 'spki', label: 'sec.keyCandidates.note.2' }); break;
        case 'PRIVATE KEY': candidates.push({ der: block.bytes, format: 'pkcs8', label: 'PKCS#8 private key' }); break;
        case 'RSA PRIVATE KEY': candidates.push({ der: pkcs1PrivateToPkcs8(block.bytes), format: 'pkcs8', label: 'sec.keyCandidates.note.3' }); break;
      }
    }
  }
  for (const jwk of jwkCandidates(input)) candidates.push({
    jwk,
    label: `JWK ${jwk.kty}${jwkIsPrivate(jwk) ? msg('sec.keyCandidates.note.5') : msg('sec.keyCandidates.note.6')}`,
  });
  if (!candidates.length) {
    const compact = input.trim().replace(/\s/g, '');
    if (compact.length > 32 && /^[A-Za-z0-9+/_=-]+$/.test(compact)) {
      try {
        const der = decodeBase64(compact);
        candidates.push(requested === 'private'
          ? { der, format: 'pkcs8', label: msg('sec.keyCandidates.note.7') }
          : { der, format: 'spki', label: msg('sec.keyCandidates.note.8') });
        candidates.push(requested === 'private'
          ? { der: pkcs1PrivateToPkcs8(der), format: 'pkcs8', label: 'sec.keyCandidates.note.3' }
          : { der: pkcs1PublicToSpki(der), format: 'spki', label: 'sec.keyCandidates.note.2' });
      } catch { /* handled by the standard missing-key error below */ }
    }
  }

  for (const candidate of candidates) {
    try {
      const raw = candidate.jwk ? cleanJwk(candidate.jwk) : undefined;
      let privateKey: CryptoKey | null = null;
      let publicKey: CryptoKey | null = null;
      let sourceIsPrivate = candidate.jwk ? jwkIsPrivate(candidate.jwk) : candidate.format === 'pkcs8';
      if (sourceIsPrivate) {
        privateKey = candidate.jwk
          ? await crypto.subtle.importKey('jwk', raw!, importParams, true, privateUsage)
          : await crypto.subtle.importKey(candidate.format!, candidate.der!.slice().buffer as ArrayBuffer, importParams, true, privateUsage);
        const privateJwk = await crypto.subtle.exportKey('jwk', privateKey);
        const publicJwk = cleanJwk(privateJwk);
        for (const key of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth']) delete (publicJwk as Record<string, unknown>)[key];
        publicKey = await crypto.subtle.importKey('jwk', publicJwk, importParams, true, publicUsage);
      } else {
        publicKey = candidate.jwk
          ? await crypto.subtle.importKey('jwk', raw!, importParams, true, publicUsage)
          : await crypto.subtle.importKey(candidate.format!, candidate.der!.slice().buffer as ArrayBuffer, importParams, true, publicUsage);
      }
      if (requested === 'private' && !privateKey) {
        failures.push('public key supplied where private key is required');
        continue;
      }
      const key = (requested === 'private' ? privateKey : publicKey)!;
      const bits = Number((key.algorithm as RsaHashedKeyAlgorithm).modulusLength ?? 0);
      const candidateLabel = candidate.label.startsWith('sec.') ? msg(candidate.label) : candidate.label;
      const label = requested === 'public' && sourceIsPrivate
        ? `${msg('sec.loadKey.text.1')}${candidateLabel}`
        : candidateLabel;
      return { jwk: (await crypto.subtle.exportKey('jwk', key)) as RsaJwk, label, derived: requested === 'public' && sourceIsPrivate, bits };
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  const field = requested === 'private' ? 'privateKey' : 'publicKey';
  throw new EngineError('bad_request', `${field} 不是可用的 RSA ${requested === 'private' ? '私钥' : '公钥'}（${failures[0] ?? '缺少密钥'}）`);
}

function utf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function rawOption(ctx: Parameters<ToolImpl['run']>[0], key: string): string {
  const value = ctx.options[key];
  return value === undefined || value === null ? '' : String(value).replace(/\r\n/g, '\n').replace(/\s+$/, '');
}

function needValue(msg: ReturnType<typeof makeMsg>, ctx: Parameters<ToolImpl['run']>[0], key: string, reason: string, example: string): string {
  const value = optStr(ctx, key);
  if (!value) throw new EngineError('bad_request', msg('common.error.badField', { field: key, reason, example }));
  return value;
}

async function emitRsa(ctx: Parameters<ToolImpl['run']>[0], blocks: string[], extra: ToolResult['extra']): Promise<ToolResult> {
  await emitText(ctx, 'rsa.txt', joinBlocks(blocks));
  ctx.report({ percent: 100, phase: 'done' });
  return { extra };
}

const SIGN_HEADER = /^signature\s*[:=]\s*(\S+)\s*\n([\s\S]*)$/i;

/** Standard RSA keys and operations handled in the in-memory Worker. */
export const embeddedRsaTool: ToolImpl = {
  id: 'rsa',
  async run(ctx): Promise<ToolResult> {
    const msg = makeMsg(localeOf(ctx));
    const mode = optSelect(ctx, 'mode', ['generate', 'encrypt', 'decrypt', 'sign', 'verify', 'pubkey'] as const, 'generate');
    const bits = Math.min(8192, Math.max(1024, Math.round(Number(ctx.options.bits) || 2048)));
    const format = optSelect(ctx, 'format', ['pem', 'jwk'] as const, 'pem');
    const hash = optSelect(ctx, 'hash', ['sha256', 'sha512'] as const, 'sha256');
    const passphrase = rawOption(ctx, 'passphrase');
    const digestName = hash === 'sha256' ? 'SHA256' : 'SHA512';
    const padding = optSelect(ctx, 'padding', ['oaep', 'pkcs1'] as const, 'oaep');

    if (mode === 'generate') {
      const oaepHashBytes = hash === 'sha256' ? 32 : 64;
      ctx.report({ percent: 25, phase: 'keygen' });
      const pair = await crypto.subtle.generateKey({
        name: 'RSASSA-PKCS1-v1_5', modulusLength: bits,
        publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256',
      }, true, ['sign', 'verify']) as CryptoKeyPair;
      const privateDer = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
      const publicDer = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
      const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
      const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
      const [sha256, sha1] = await Promise.all([groupedFingerprint(publicDer, 'SHA-256'), groupedFingerprint(publicDer, 'SHA-1')]);
      const generatedPrivate = forge.pki.privateKeyFromAsn1(forge.asn1.fromDer(binaryString(privateDer)));
      const privatePem = passphrase ? forgeEncryptedPrivatePem(generatedPrivate, passphrase) : pem('PRIVATE KEY', privateDer);
      const publicPem = pem('PUBLIC KEY', publicDer);
      const privateText = format === 'jwk' ? jwkText(privateJwk, 'private') : privatePem;
      const publicText = format === 'jwk' ? jwkText(publicJwk, 'public') : publicPem;
      ctx.report({ percent: 85, phase: 'render' });
      return emitRsa(ctx, [
        section(msg('sec.rsa.section.3', { bits, format: format.toUpperCase() })),
        alignRows([
          [msg('sec.rsa.row.4'), `rsa · ${bits} bit`],
          [msg('sec.rsa.row.5'), passphrase ? msg('sec.rsa.row.6') : msg('sec.rsa.row.7')],
          [msg('sec.rsa.row.8'), 'SPKI'],
          [msg('sec.rsa.section.4'), sha256],
          [msg('sec.rsa.row.9'), sha1],
          [msg('sec.rsa.row.10'), msg('sec.rsa.section.5', { bits: Math.floor(bits / 8) - 2 * oaepHashBytes - 2 })],
          [msg('sec.rsa.row.11'), msg('sec.rsa.section.5', { bits: Math.floor(bits / 8) - 11 })],
        ]),
        section(msg('sec.rsa.section.6')), privateText,
        section(msg('sec.rsa.section.7')), publicText,
        section(msg('common.section.notes')),
        [msg('sec.rsa.row.12'), passphrase ? msg('sec.rsa.row.13') : msg('sec.rsa.row.14'), msg('sec.rsa.row.15'), msg('sec.rsa.row.16')].join('\n'),
      ], { mode, bits, format, keyEncrypted: passphrase ? 'yes' : 'no', publicPem: publicText.replace(/\n/g, '').replace(/\s/g, '') });
    }

    if (mode === 'encrypt' || mode === 'decrypt') {
      const message = needValue(msg, ctx, 'message', msg(mode === 'encrypt' ? 'sec.rsa.reason.1' : 'sec.rsa.reason.2'), mode === 'encrypt' ? 'attack at dawn' : msg('sec.rsa.reason.3'));
      const blockBytes = Math.floor(bits / 8);
      const maxBytes = blockBytes - (padding === 'oaep' ? 2 * (hash === 'sha256' ? 32 : 64) + 2 : 11);
      if (mode === 'encrypt') {
        const loaded = await loadRsaKey(rawOption(ctx, 'publicKey'), 'public', padding === 'oaep' ? 'oaep' : 'signature', hash, msg, passphrase);
        const source = new TextEncoder().encode(message);
        if (source.length > maxBytes) throw new EngineError('bad_request', msg('sec.rsa.reason.4', { source: source.length, padding: padding.toUpperCase(), digestName, maxBytes }));
        const key = await crypto.subtle.importKey('jwk', cleanJwk(loaded.jwk), keyImportAlgorithm('oaep', hash), true, ['encrypt']);
        let out: Uint8Array;
        try {
          out = padding === 'oaep'
            ? new Uint8Array(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, source))
            : Uint8Array.from(forgePublicFromJwk(loaded.jwk).encrypt(binaryString(source), 'RSAES-PKCS1-V1_5'), (character) => character.charCodeAt(0));
        } catch (error) { throw new EngineError('bad_request', error instanceof Error ? error.message : String(error)); }
        const encoded = bytesToBase64(out);
        return emitRsa(ctx, [
          section(msg('sec.rsa.section.10', { padding: padding.toUpperCase(), digestName })),
          section(msg('common.label.result')), encoded,
          alignRows([
            [msg('common.label.secret'), `${loaded.label}${loaded.derived ? msg('sec.rsa.row.21') : ''}`],
            [msg('sec.rsa.row.3'), msg('sec.rsa.row.22', { source: source.length, maxBytes })],
            [msg('sec.rsa.row.1'), msg('sec.rsa.row.23', { out: out.length, blockBytes })],
            [msg('sec.rsa.section.11'), msg('sec.rsa.sectionx.2', { digestName })],
          ]),
          section(msg('common.section.notes')),
          [msg('sec.rsa.row.24'), msg('sec.rsa.row.25'), msg('sec.rsa.row.26')].join('\n'),
        ], { mode, padding, hash, bytes: out.length, cipher: encoded });
      }
      const loaded = await loadRsaKey(rawOption(ctx, 'privateKey'), 'private', padding === 'oaep' ? 'oaep' : 'signature', hash, msg, passphrase);
      let cipherBytes: Uint8Array;
      try { cipherBytes = decodeBase64(message); }
      catch { throw new EngineError('bad_request', msg('sec.rsa.reason.6', { blockBytes, bits, cipherBytes: 0 })); }
      if (!cipherBytes.length || cipherBytes.length !== blockBytes) {
        throw new EngineError('bad_request', msg('sec.rsa.reason.6', { blockBytes, bits, cipherBytes: cipherBytes.length }));
      }
      let plain: Uint8Array;
      try {
        if (padding === 'oaep') {
          const key = await crypto.subtle.importKey('jwk', cleanJwk(loaded.jwk), keyImportAlgorithm('oaep', hash), true, ['decrypt']);
          plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, key, arrayBuffer(cipherBytes)));
        } else {
          plain = Uint8Array.from(forgePrivateFromJwk(loaded.jwk).decrypt(binaryString(cipherBytes), 'RSAES-PKCS1-V1_5'), (character) => character.charCodeAt(0));
        }
      } catch (error) {
        throw new EngineError('bad_request', msg('sec.rsa.error.1', { message: error instanceof Error ? error.message : String(error) }));
      }
      const text = utf8(plain);
      if (hex(new TextEncoder().encode(text)) !== hex(plain)) throw new EngineError('bad_request', msg('sec.rsa.error.2', { plain: plain.length, plain2: hex(plain).slice(0, 64) }));
      return emitRsa(ctx, [
        section(msg('sec.rsa.section.13', { padding: padding.toUpperCase(), digestName })),
        section(msg('common.label.result')), text,
        alignRows([
          [msg('common.label.secret'), loaded.label],
          [msg('sec.rsa.row.1'), msg('sec.rsa.row.27', { cipherBytes: cipherBytes.length })],
          [msg('sec.rsa.row.3'), msg('sec.rsa.row.2', { plain: plain.length })],
          [msg('sec.rsa.section.2'), msg('sec.rsa.section.14')],
        ]),
        section(msg('common.section.notes')), msg('sec.rsa.row.28'), msg('sec.rsa.row.29'),
      ], { mode, padding, hash, bytes: plain.length, text });
    }

    if (mode === 'sign') {
      const message = needValue(msg, ctx, 'message', msg('sec.rsa.reason.8'), 'attack at dawn');
      const loaded = await loadRsaKey(rawOption(ctx, 'privateKey'), 'private', 'signature', hash, msg, passphrase);
      const source = new TextEncoder().encode(message);
      const key = await crypto.subtle.importKey('jwk', cleanJwk(loaded.jwk), keyImportAlgorithm('signature', hash), true, ['sign']);
      const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, source));
      const encoded = bytesToBase64(signature);
      return emitRsa(ctx, [
        section(msg('sec.rsa.section.15', { digestName })), section(msg('common.label.result')), encoded,
        alignRows([
          [msg('common.label.secret'), loaded.label],
          [msg('sec.rsa.row.30'), msg('sec.rsa.row.31', { source: source.length })],
          [msg('sec.rsa.row.32'), msg('sec.rsa.row.33', { signature: signature.length })],
          [msg('sec.rsa.section.11'), msg('sec.rsa.sectionx.1')],
        ]),
        section(msg('sec.rsa.section.17')), hex(signature),
        section(msg('sec.rsa.section.18')), `signature: ${encoded}\n${message}`,
        section(msg('common.section.notes')),
        [msg('sec.rsa.row.34'), msg('sec.rsa.row.35'), msg('sec.rsa.row.36')].join('\n'),
      ], { mode, hash, bytes: signature.length, signature: encoded });
    }

    if (mode === 'verify') {
      const combined = needValue(msg, ctx, 'message', msg('sec.rsa.reason.9'), msg('sec.rsa.reason.10'));
      let signatureText = '';
      let content = '';
      const headerMatch = SIGN_HEADER.exec(combined);
      if (headerMatch) { signatureText = headerMatch[1]!; content = headerMatch[2]!; }
      else {
        const lines = combined.split('\n');
        const last = lines[lines.length - 1] ?? '';
        const expectedLength = 4 * Math.ceil(Math.floor(bits / 8) / 3);
        if (lines.length > 1 && /^[A-Za-z0-9+/]+={0,2}$/.test(last.trim()) && last.trim().length === expectedLength) {
          signatureText = last.trim(); content = lines.slice(0, -1).join('\n');
        } else throw new EngineError('bad_request', msg('sec.rsa.reason.11'));
      }
      let signature: Uint8Array;
      try { signature = decodeBase64(signatureText); }
      catch { throw new EngineError('bad_request', msg('sec.rsa.reason.12')); }
      if (!signature.length) throw new EngineError('bad_request', msg('sec.rsa.reason.12'));
      const loaded = await loadRsaKey(rawOption(ctx, 'publicKey'), 'public', 'signature', hash, msg);
      const contentBytes = new TextEncoder().encode(content.replace(/\n$/, ''));
      const key = await crypto.subtle.importKey('jwk', cleanJwk(loaded.jwk), keyImportAlgorithm('signature', hash), true, ['verify']);
      let ok: boolean;
      try { ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, arrayBuffer(signature), contentBytes); }
      catch (error) { throw new EngineError('bad_request', msg('sec.rsa.error.3', { message: error instanceof Error ? error.message : String(error) })); }
      return emitRsa(ctx, [
        section(msg('sec.rsa.section.19', { digestName })), section(msg('common.label.result')),
        ok ? msg('sec.rsa.section.20') : msg('sec.rsa.section.21'),
        alignRows([
          [msg('common.label.secret'), `${loaded.label}${loaded.derived ? msg('sec.rsa.row.21') : ''}`],
          [msg('sec.rsa.row.37'), msg('sec.rsa.row.38', { contentBytes: contentBytes.length })],
          [msg('sec.rsa.row.32'), msg('sec.rsa.row.39', { signatureBytes: signature.length })],
          [msg('common.label.result'), ok ? msg('sec.rsa.section.20') : msg('sec.rsa.section.21')],
        ]),
        section(msg('sec.rsa.section.22')), content.replace(/\n$/, ''),
        section(msg('common.section.notes')),
        [msg('sec.rsa.row.40'), msg('sec.rsa.row.41', { row: content === combined ? msg('sec.rsa.row.42') : '' }), msg('sec.rsa.row.43')].join('\n'),
      ], { mode, hash, ok: ok ? 'yes' : 'no', keyBytes: Math.floor(bits / 8) });
    }

    if (mode === 'pubkey') {
      const loaded = await loadRsaKey(rawOption(ctx, 'privateKey'), 'private', 'signature', 'sha256', msg, passphrase);
      const publicJwk = cleanJwk(loaded.jwk);
      for (const keyName of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth']) delete (publicJwk as Record<string, unknown>)[keyName];
      const publicKey = await crypto.subtle.importKey('jwk', publicJwk, keyImportAlgorithm('signature', 'sha256'), true, ['verify']);
      const der = new Uint8Array(await crypto.subtle.exportKey('spki', publicKey));
      const publicText = format === 'jwk' ? jwkText(await crypto.subtle.exportKey('jwk', publicKey), 'public') : pem('PUBLIC KEY', der);
      const [sha256] = await Promise.all([groupedFingerprint(der, 'SHA-256')]);
      return emitRsa(ctx, [
        section(msg('sec.rsa.section.8')),
        alignRows([
          [msg('sec.rsa.row.17'), loaded.label],
          [msg('sec.summaryRows.row.1'), `rsa · ${loaded.bits} bit`],
          [msg('sec.rsa.row.18'), format === 'jwk' ? msg('sec.rsa.row.19') : msg('sec.rsa.rowx.1')],
          [msg('sec.rsa.section.4'), sha256],
        ]),
        section(msg('sec.rsa.section.9')), publicText,
        section(msg('common.section.notes')), msg('sec.rsa.row.20'),
      ], { mode, format, bits: loaded.bits, publicPem: publicText.replace(/\n/g, '').replace(/\s/g, '') });
    }

    throw new EngineError('bad_request', '不支持的 RSA 操作');
  },
};
