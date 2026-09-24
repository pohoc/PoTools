import forge from 'node-forge';
import { EngineError } from '../errors.ts';
import { localeOf, makeMsg } from '../lib/messages.ts';
import type { ToolImpl } from '../types.ts';
import { DAY_MS, alignRows, emitText, joinBlocks, optBool, optSelect, optStr, phraseLocale, relativePhrase, section } from './time-core.ts';

type Row = [string, string];
type Msg = ReturnType<typeof makeMsg>;

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function bytesFromBinary(value: string): Uint8Array {
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}

function binaryFromBytes(bytes: Uint8Array): string {
  let value = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    value += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return value;
}

function oidFromAsn1(value: string): string {
  return forge.asn1.derToOid(forge.util.createBuffer(value));
}

function binaryFromBase64(value: string): string {
  return atob(value.replace(/\s/g, ''));
}

function certificateDer(pem: string): Uint8Array {
  return bytesFromBinary(binaryFromBase64(pem.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----/g, '')));
}

async function fingerprint(bytes: Uint8Array, algorithm: 'SHA-1' | 'SHA-256' | 'SHA-512'): Promise<string> {
  const digest = await crypto.subtle.digest(algorithm, bytes.slice().buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('').replace(/(.{2})(?!$)/g, '$1:').toUpperCase();
}

function pemBlock(value: string): string {
  const body = value.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----/g, '').replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) throw new Error('invalid PEM encoding');
  const der = binaryFromBase64(body);
  if (!der.length) throw new Error('empty certificate');
  const wrapped = (body.match(/.{1,64}/g) ?? []).join('\n');
  return `-----BEGIN CERTIFICATE-----\n${wrapped}\n-----END CERTIFICATE-----`;
}

interface ParsedNonRsaKey {
  algorithm: string;
  curve?: string;
  bits: number;
  pem: string;
}

const PUBLIC_KEY_ALGORITHMS: Record<string, string> = {
  '1.2.840.10045.2.1': 'ec',
  '1.3.101.112': 'ed25519',
  '1.3.101.113': 'ed448',
  '1.3.101.110': 'x25519',
  '1.3.101.111': 'x448',
};

const EC_CURVES: Record<string, { name: string; bits: number }> = {
  '1.2.840.10045.3.1.1': { name: 'prime192v1', bits: 192 },
  '1.2.840.10045.3.1.7': { name: 'prime256v1', bits: 256 },
  '1.3.132.0.31': { name: 'secp192k1', bits: 192 },
  '1.3.132.0.32': { name: 'secp224k1', bits: 224 },
  '1.3.132.0.33': { name: 'secp224r1', bits: 224 },
  '1.3.132.0.10': { name: 'secp256k1', bits: 256 },
  '1.3.132.0.34': { name: 'secp384r1', bits: 384 },
  '1.3.132.0.35': { name: 'secp521r1', bits: 521 },
  '1.3.36.3.3.2.8.1.1.7': { name: 'brainpoolP256r1', bits: 256 },
  '1.3.36.3.3.2.8.1.1.9': { name: 'brainpoolP320r1', bits: 320 },
  '1.3.36.3.3.2.8.1.1.11': { name: 'brainpoolP384r1', bits: 384 },
  '1.3.36.3.3.2.8.1.1.13': { name: 'brainpoolP512r1', bits: 512 },
};

function nonRsaKeyFromAsn1(spki: forge.asn1.Asn1): ParsedNonRsaKey | undefined {
  if (!Array.isArray(spki.value) || spki.value.length < 2) return undefined;
  const [algorithmNode, bitString] = spki.value as forge.asn1.Asn1[];
  if (!Array.isArray(algorithmNode?.value) || typeof bitString?.value !== 'string') return undefined;
  const [algorithmOidNode, parameterNode] = algorithmNode.value as forge.asn1.Asn1[];
  if (typeof algorithmOidNode?.value !== 'string') return undefined;
  const algorithmOid = oidFromAsn1(algorithmOidNode.value);
  const algorithm = PUBLIC_KEY_ALGORITHMS[algorithmOid];
  if (!algorithm) return undefined;
  const parameterOid = typeof parameterNode?.value === 'string' && parameterNode.type === forge.asn1.Type.OID
    ? oidFromAsn1(parameterNode.value)
    : '';
  const curve = EC_CURVES[parameterOid];
  if (algorithm === 'ec' && !curve) return undefined;
  const unusedBits = bitString.value.charCodeAt(0);
  if (unusedBits !== 0) return undefined;
  const keyBytes = bitString.value.length - 1;
  const bits = curve?.bits ?? keyBytes * 8;
  if (bits < 1) return undefined;
  const der = forge.asn1.toDer(spki).getBytes();
  const base64 = btoa(der).replace(/(.{1,64})/g, '$1\n').trim();
  return {
    algorithm: algorithm === 'ec' ? 'ec' : algorithm,
    curve: curve?.name,
    bits,
    pem: `-----BEGIN PUBLIC KEY-----\n${base64}\n-----END PUBLIC KEY-----`,
  };
}

function subjectPublicKeyInfo(certAsn1: forge.asn1.Asn1): { tbs: forge.asn1.Asn1; index: number; spki: forge.asn1.Asn1 } {
  const outer = certAsn1.value as forge.asn1.Asn1[];
  const tbs = outer[0];
  const fields = tbs?.value;
  if (!Array.isArray(fields)) throw new Error('invalid TBSCertificate');
  const index = fields.findIndex((field) => {
    if (!Array.isArray(field.value) || field.value.length !== 2) return false;
    const [algorithm, key] = field.value as forge.asn1.Asn1[];
    return algorithm?.type === forge.asn1.Type.SEQUENCE && key?.type === forge.asn1.Type.BITSTRING;
  });
  if (index < 0) throw new Error('missing SubjectPublicKeyInfo');
  return { tbs: tbs!, index, spki: fields[index]! };
}

function pemFromDer(der: string): string {
  const body = btoa(der).replace(/(.{1,64})/g, '$1\n').trim();
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;
}

function serialNumber(cert: forge.pki.Certificate): string {
  return cert.serialNumber.replace(/^0+/, '').toUpperCase() || '0';
}

function certificateFromPem(pem: string): forge.pki.Certificate {
  const normalized = pemBlock(pem);
  const der = certificateDer(normalized);
  const originalAsn1 = forge.asn1.fromDer(binaryFromBytes(der));
  const { spki } = subjectPublicKeyInfo(originalAsn1);
  const key = nonRsaKeyFromAsn1(spki);
  if (!key) return forge.pki.certificateFromPem(normalized, false, true);

  // node-forge's X.509 parser hardcodes RSA at the final SPKI conversion step.
  // Substitute a parse-only RSA key in a copy, then restore the original SPKI
  // metadata on the returned certificate. The user's DER bytes stay untouched.
  const copy = forge.asn1.fromDer(binaryFromBytes(der));
  const clonedSpki = subjectPublicKeyInfo(copy);
  const fields = clonedSpki.tbs.value as forge.asn1.Asn1[];
  const placeholder = {
    n: new forge.jsbn.BigInteger('f'.repeat(128), 16),
    e: new forge.jsbn.BigInteger('10001', 16),
  } as unknown as forge.pki.rsa.PublicKey;
  fields[clonedSpki.index] = forge.pki.publicKeyToAsn1(placeholder);
  const parsed = forge.pki.certificateFromPem(pemFromDer(forge.asn1.toDer(copy).getBytes()), false, true);
  parsed.publicKey = key as unknown as forge.pki.rsa.PublicKey;
  return parsed;
}

export function canParseEmbeddedX509(pem: string): boolean {
  const block = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/)?.[0];
  if (!block) return false;
  try {
    certificateFromPem(block);
    return true;
  } catch {
    return false;
  }
}

function dn(cert: forge.pki.Certificate['subject']): string {
  return cert.attributes.map((attribute) => {
    const name = attribute.shortName ?? attribute.name ?? attribute.type ?? 'OID';
    const value = String(attribute.value ?? '').replace(/([,\\])/g, '\\$1');
    return `${name}=${value}`;
  }).join('\n');
}

function extension(cert: forge.pki.Certificate, name: string): Record<string, unknown> | undefined {
  return cert.extensions.find((item) => {
    const value = item as Record<string, unknown>;
    return value.name === name || value.id === name;
  }) as Record<string, unknown> | undefined;
}

function authorityKeyIdentifier(cert: forge.pki.Certificate): string | undefined {
  const value = extension(cert, 'authorityKeyIdentifier')?.value;
  if (typeof value !== 'string') return undefined;
  const bytes = bytesFromBinary(value);
  for (let index = 0; index < bytes.length - 2; index += 1) {
    if (bytes[index] !== 0x80) continue;
    let length = bytes[index + 1]!;
    let start = index + 2;
    if (length & 0x80) {
      const count = length & 0x7f;
      length = 0;
      for (let offset = 0; offset < count; offset += 1) length = length * 256 + bytes[start + offset]!;
      start += count;
    }
    if (length > 0 && start + length <= bytes.length) return hex(bytes.subarray(start, start + length)).toUpperCase();
  }
  return undefined;
}

function infoAccessValues(cert: forge.pki.Certificate): string[] {
  const raw = extension(cert, 'authorityInfoAccess')?.value;
  if (typeof raw !== 'string') return [];
  try {
    const sequence = forge.asn1.fromDer(raw, true);
    const descriptions = Array.isArray(sequence.value) ? sequence.value as forge.asn1.Asn1[] : [];
    return descriptions.flatMap((description) => {
      if (!Array.isArray(description.value) || description.value.length < 2) return [];
      const [methodNode, location] = description.value as forge.asn1.Asn1[];
      if (typeof methodNode?.value !== 'string' || typeof location?.value !== 'string') return [];
      const methodOid = oidFromAsn1(methodNode.value);
      const method = methodOid === '1.3.6.1.5.5.7.48.1' ? 'OCSP' : methodOid === '1.3.6.1.5.5.7.48.2' ? 'caIssuers' : methodOid;
      const name = location.type === 6 ? 'URI' : location.type === 2 ? 'DNS' : location.type === 1 ? 'email' : location.type === 7 ? 'IP Address' : `GeneralName ${location.type}`;
      return [`${method} - ${name}:${location.value}`];
    });
  } catch {
    return [];
  }
}

function ipFromBytes(value: string): string {
  const octets = Array.from(value, (character) => character.charCodeAt(0));
  if (octets.length === 4) return octets.join('.');
  if (octets.length !== 16) return hex(Uint8Array.from(octets));
  const groups: number[] = [];
  for (let index = 0; index < 16; index += 2) groups.push((octets[index]! << 8) | octets[index + 1]!);
  return groups.map((group) => group.toString(16)).join(':');
}

function sanEntries(msg: Msg, cert: forge.pki.Certificate): Row[] {
  const san = extension(cert, 'subjectAltName');
  const values = Array.isArray(san?.altNames) ? san.altNames as Array<Record<string, unknown>> : [];
  return values.map((item) => {
    const type = Number(item.type);
    const value = String(item.value ?? '');
    if (type === 1) return ['  email', value];
    if (type === 2) return ['  DNS', value];
    if (type === 4) {
      const directory = item.directoryName as forge.pki.Certificate['subject'] | undefined;
      return ['  DIRNAME', directory?.attributes ? dn(directory) : value];
    }
    if (type === 6) return ['  URI', value];
    if (type === 7) return ['  IP', ipFromBytes(value)];
    return [msg('sec.sanEntries.note.1'), `${type}: ${value}`];
  });
}

function parseDn(msg: Msg, raw: string): Row[] {
  const protectedCommas = raw.replace(/\\,/g, '\u0001');
  const rows = protectedCommas.split(',').map((part) => part.trim().replace(/\u0001/g, ',')).filter(Boolean).map((part, index): Row => {
    const equal = part.indexOf('=');
    return equal < 0 ? [msg('sec.parseDn.note.1', { p0: index + 1 }), part] : [`  ${part.slice(0, equal).trim()}`, part.slice(equal + 1).trim()];
  });
  return rows.length ? rows : [[msg('sec.parseDn.label.1'), raw || msg('sec.readExtensions.text.1')]];
}

function extensionRows(msg: Msg, cert: forge.pki.Certificate, sans: Row[]): Row[] {
  const basic = extension(cert, 'basicConstraints');
  const usage = extension(cert, 'keyUsage');
  const eku = extension(cert, 'extKeyUsage');
  const subjectId = extension(cert, 'subjectKeyIdentifier');
  const authorityId = extension(cert, 'authorityKeyIdentifier');
  const none = msg('common.value.none');
  const subjectKeyId = subjectId?.subjectKeyIdentifier
    ? String(subjectId.subjectKeyIdentifier).toUpperCase()
    : none;
  const authorityKeyId = authorityKeyIdentifier(cert)
    ?? (authorityId && subjectId?.subjectKeyIdentifier ? String(subjectId.subjectKeyIdentifier).toUpperCase() : none);
  const keyNames = [
    ['digitalSignature', 'sec.keyUsage.text.1'], ['nonRepudiation', 'sec.keyUsage.text.2'], ['keyEncipherment', 'sec.keyUsage.text.3'],
    ['dataEncipherment', 'sec.keyUsage.text.4'], ['keyAgreement', 'sec.keyUsage.text.5'], ['keyCertSign', 'sec.keyUsage.text.6'],
    ['cRLSign', 'sec.keyUsage.text.7'], ['encipherOnly', 'sec.keyUsage.text.8'], ['decipherOnly', 'sec.keyUsage.text.9'],
  ] as const;
  const keyUsageText = usage ? keyNames.filter(([key]) => usage[key] === true).map(([, key]) => msg(key)).join(msg('common.list.sep')) : msg('sec.x509.row.1');
  const keyUsage = usage ? `${keyUsageText || msg('sec.readExtensions.text.2')}${usage.critical ? ' · critical' : ''}` : keyUsageText;
  const ekuOids: Record<string, string> = {
    serverAuth: '1.3.6.1.5.5.7.3.1', clientAuth: '1.3.6.1.5.5.7.3.2', codeSigning: '1.3.6.1.5.5.7.3.3',
    emailProtection: '1.3.6.1.5.5.7.3.4', timeStamping: '1.3.6.1.5.5.7.3.8', OCSPSigning: '1.3.6.1.5.5.7.3.9',
    '2.23.140.1.2.1': '2.23.140.1.2.1', '2.23.140.1.2.2': '2.23.140.1.2.2',
  };
  const ekuLabels: Record<string, string> = {
    '1.3.6.1.5.5.7.3.1': 'sec.eku.text.1', '1.3.6.1.5.5.7.3.2': 'sec.eku.text.2', '1.3.6.1.5.5.7.3.3': 'sec.eku.text.3',
    '1.3.6.1.5.5.7.3.4': 'sec.eku.text.4', '1.3.6.1.5.5.7.3.8': 'sec.eku.text.5', '1.3.6.1.5.5.7.3.9': 'sec.eku.text.6',
    '2.23.140.1.2.1': 'sec.eku.text.7', '2.23.140.1.2.2': 'sec.eku.text.8',
  };
  const ekuNames = eku ? Object.entries(eku).filter(([key, value]) => value === true && ekuOids[key]).map(([key]) => {
    const oid = ekuOids[key]!;
    return msg(ekuLabels[oid] ?? oid);
  }).join(msg('common.list.sep')) : msg('sec.x509.row.1');
  const ca = basic?.cA === true;
  const critical = cert.extensions.filter((item) => (item as Record<string, unknown>).critical === true).map((item) => String((item as Record<string, unknown>).id ?? '')).filter(Boolean).join(msg('common.list.sep')) || msg('common.value.none');
  const sigOid = cert.siginfo.algorithmOid;
  const sigNames: Record<string, string> = {
    '1.2.840.113549.1.1.5': 'sha1WithRSAEncryption', '1.2.840.113549.1.1.11': 'sha256WithRSAEncryption',
    '1.2.840.113549.1.1.12': 'sha384WithRSAEncryption', '1.2.840.113549.1.1.13': 'sha512WithRSAEncryption',
    '1.2.840.10045.4.3.2': 'ecdsa-with-SHA256', '1.2.840.10045.4.3.3': 'ecdsa-with-SHA384',
  };
  const access = infoAccessValues(cert);
  return [
    [msg('sec.extensionRows.row.2'), `X.509 v${cert.version + 1}`],
    [msg('sec.extensionRows.row.3'), sigNames[sigOid] ?? sigOid],
    [msg('sec.extensionRows.row.4'), sigOid],
    ['basicConstraints', basic ? `CA:${ca ? 'TRUE' : 'FALSE'}${basic.pathLenConstraint === undefined ? '' : `, pathlen:${String(basic.pathLenConstraint)}`}${basic.critical ? ' · critical' : ''}` : msg('sec.x509.row.1')],
    [msg('sec.extensionRows.row.5'), msg('sec.extensionRows.row.6', { row: ca ? msg('sec.extensionRows.row.7') : msg('sec.extensionRows.row.8'), ca: String(ca) })],
    ['keyUsage', keyUsage], ['extendedKeyUsage', ekuNames],
    ['subjectKeyIdentifier', subjectKeyId],
    ['authorityKeyIdentifier', authorityKeyId],
    [msg('sec.extensionRows.row.9'), critical], [msg('sec.extensionRows.row.10'), String(sans.length)],
    [msg('sec.extensionRows.rowx.1'), access.length ? access.join(' · ') : msg('common.value.none')],
  ];
}

function validityRows(msg: Msg, locale: 'zh-CN' | 'en', cert: forge.pki.Certificate): Row[] {
  const from = cert.validity.notBefore.getTime();
  const to = cert.validity.notAfter.getTime();
  const now = Date.now();
  const remaining = (to - now) / DAY_MS;
  const total = (to - from) / DAY_MS;
  const offset = -new Date().getTimezoneOffset();
  const zone = `UTC${offset >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')}:${String(Math.abs(offset) % 60).padStart(2, '0')}`;
  const local = (value: number) => new Date(value).toLocaleString(phraseLocale(locale, 'zh-CN'), { hour12: false });
  return [
    ['notBefore', msg('sec.validityRows.row.2', { notBefore: local(from), zone, toISOString: new Date(from).toISOString() })],
    ['notAfter', msg('sec.validityRows.row.3', { notAfter: local(to), zone, toISOString: new Date(to).toISOString() })],
    [msg('sec.validityRows.row.4'), msg('sec.validityRows.row.5', { row: remaining >= 0 ? msg('sec.validityRows.row.6') : msg('sec.validityRows.row.7'), remainingDays: Math.abs(remaining).toFixed(2), now: relativePhrase(to - now, phraseLocale(locale, 'zh-CN')) })],
    [msg('sec.validityRows.row.8'), msg('sec.validityRows.row.9', { totalDays: total.toFixed(2), row: total > 398 ? msg('sec.validityRows.row.10') : msg('sec.validityRows.row.11') })],
    [msg('sec.validityRows.row.12'), now < from ? msg('sec.validityRows.row.13') : now > to ? msg('sec.validityRows.row.14') : msg('sec.validityRows.row.1')],
  ];
}

function opensslTime(value: Date): string {
  const year = value.getUTCFullYear();
  const month = value.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const day = String(value.getUTCDate()).padStart(2, ' ');
  const clock = `${String(value.getUTCHours()).padStart(2, '0')}:${String(value.getUTCMinutes()).padStart(2, '0')}:${String(value.getUTCSeconds()).padStart(2, '0')}`;
  return `${month} ${day} ${clock} ${year} GMT`;
}

function signatureAlgorithm(cert: forge.pki.Certificate): string {
  const names: Record<string, string> = {
    '1.2.840.113549.1.1.5': 'sha1WithRSAEncryption', '1.2.840.113549.1.1.11': 'sha256WithRSAEncryption',
    '1.2.840.113549.1.1.12': 'sha384WithRSAEncryption', '1.2.840.113549.1.1.13': 'sha512WithRSAEncryption',
    '1.2.840.10045.4.3.2': 'ecdsa-with-SHA256', '1.2.840.10045.4.3.3': 'ecdsa-with-SHA384',
  };
  return names[cert.siginfo.algorithmOid] ?? cert.siginfo.algorithmOid;
}

function publicKeyPem(cert: forge.pki.Certificate): string {
  const key = cert.publicKey as unknown as ParsedNonRsaKey & { n?: unknown };
  return typeof key.pem === 'string' ? key.pem : forge.pki.publicKeyToPem(cert.publicKey).trim();
}

async function certSummary(msg: Msg, cert: forge.pki.Certificate, pem: string): Promise<Row[]> {
  const der = certificateDer(pem);
  const publicPem = publicKeyPem(cert);
  const publicDer = bytesFromBinary(binaryFromBase64(publicPem.replace(/-----[^-]+-----/g, '')));
  const key = cert.publicKey as unknown as ParsedNonRsaKey & { n?: forge.jsbn.BigInteger };
  const bits = key.n && typeof (key.n as forge.jsbn.BigInteger).bitLength === 'function' ? (key.n as forge.jsbn.BigInteger).bitLength() : 0;
  // Node's KeyObject reports namedCurve for EC keys but no key-size field;
  // retain that output shape so Worker and Node summaries stay compatible.
  const keyBits = key.n ? bits : 0;
  const algorithm = key.n ? 'rsa' : key.algorithm || 'unknown';
  const serial = serialNumber(cert);
  return [
    [msg('sec.summaryRows.row.2'), serialNumber(cert)],
    [msg('sec.summaryRows.row.3'), BigInt(`0x${serial}`).toString()],
    [msg('sec.summaryRows.row.1'), `${algorithm}${keyBits ? ` · ${keyBits} bit` : ''}${key.curve ? msg('sec.summaryRows.row.4', { curve: key.curve }) : ''}`],
    [msg('sec.summaryRows.row.5'), msg('sec.summaryRows.row.6', { der: der.length })],
    [msg('sec.summaryRows.row.7'), await fingerprint(publicDer, 'SHA-256')],
    [msg('sec.summaryRows.row.8'), await fingerprint(der, 'SHA-1')],
    [msg('sec.summaryRows.row.9'), await fingerprint(der, 'SHA-256')],
    [msg('sec.summaryRows.row.10'), await fingerprint(der, 'SHA-512')],
  ];
}

function jsonOf(msg: Msg, cert: forge.pki.Certificate, block: string, sans: Row[]): Record<string, unknown> {
  const from = cert.validity.notBefore.getTime();
  const to = cert.validity.notAfter.getTime();
  const basic = extension(cert, 'basicConstraints');
  const usages = extensionRows(msg, cert, sans);
  const byLabel = (label: string) => usages.find(([name]) => name === label)?.[1] ?? '';
  const subjectAltName: Record<string, string> = {};
  for (const [index, [kind, value]] of sans.entries()) subjectAltName[`${kind.trim()}${kind.trim() === msg('sec.jsonOf.text.1') ? index + 1 : ''}`] = value;
  return {
    subject: dn(cert.subject), issuer: dn(cert.issuer), serialNumber: serialNumber(cert),
    version: `X.509 v${cert.version + 1}`, signatureAlgorithm: signatureAlgorithm(cert),
    subjectAltName, validFrom: opensslTime(cert.validity.notBefore), validTo: opensslTime(cert.validity.notAfter),
    validityIso: { notBefore: new Date(from).toISOString(), notAfter: new Date(to).toISOString() },
    remainingDays: Number(((to - Date.now()) / DAY_MS).toFixed(4)), expired: Date.now() > to,
    ca: basic?.cA === true,
    basicConstraints: byLabel('basicConstraints'), keyUsage: byLabel('keyUsage'), extendedKeyUsage: byLabel('extendedKeyUsage'),
    subjectKeyIdentifier: byLabel('subjectKeyIdentifier'), authorityKeyIdentifier: byLabel('authorityKeyIdentifier'),
    infoAccess: infoAccessValues(cert).length ? infoAccessValues(cert).join('\n') : [], fingerprintSha1: '', fingerprintSha256: '', fingerprintSha512: '', publicKeyPem: '[object KeyObject]', pem: block,
  };
}

export const embeddedX509Tool: ToolImpl = {
  id: 'x509',
  async run(ctx) {
    const locale = localeOf(ctx);
    const msg = makeMsg(locale);
    const rawPem = optStr(ctx, 'pem');
    if (!rawPem.trim()) throw new EngineError('bad_request', msg('common.error.badField', { field: 'pem', reason: msg('sec.x509.reason.1'), example: '-----BEGIN CERTIFICATE-----…' }));
    if (/-----BEGIN (?:NEW )?CERTIFICATE REQUEST-----/.test(rawPem)) throw new EngineError('bad_request', msg('common.error.badField', { field: 'pem', reason: msg('sec.x509.reason.2'), example: '-----BEGIN CERTIFICATE-----…' }));
    const blocks = [...rawPem.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)].map((match) => match[0]);
    if (!blocks.length) throw new EngineError('bad_request', msg('common.error.badField', { field: 'pem', reason: msg('sec.x509.reason.3'), example: '-----BEGIN CERTIFICATE-----…' }));
    ctx.report({ percent: 35, phase: 'parse' });
    const warnings: string[] = [];
    const parsed: Array<{ cert: forge.pki.Certificate; pem: string; der: Uint8Array }> = [];
    for (const [index, candidate] of blocks.entries()) {
      try {
        const pem = candidate.trim();
        const cert = certificateFromPem(pem);
        parsed.push({ cert, pem, der: certificateDer(pem) });
      } catch (error) {
        if (index === 0) throw new EngineError('bad_request', msg('common.error.badField', { field: 'pem', reason: msg('sec.x509.reason.4', { message: error instanceof Error ? error.message : String(error) }), example: msg('sec.x509.reason.5') }));
        warnings.push(msg('sec.x509.warn.1', { p0: index + 1, message: error instanceof Error ? error.message : String(error) }));
      }
    }
    if (!parsed.length) throw new EngineError('bad_request', msg('sec.x509.reason.6'));
    const showChain = optBool(ctx, 'chain', false);
    const output = optSelect(ctx, 'output', ['summary', 'full-json'] as const, 'summary');
    const shown = showChain ? parsed : parsed.slice(0, 1);
    const primary = parsed[0]!.cert;
    const out: string[] = [];
    for (const [index, item] of shown.entries()) {
      const cert = item.cert;
      const subject = dn(cert.subject);
      const issuer = dn(cert.issuer);
      const sans = sanEntries(msg, cert);
      const basic = extension(cert, 'basicConstraints');
      const notAfter = cert.validity.notAfter.getTime();
      const chainLabel = index === 0 ? msg('sec.x509.section.2') : subject === issuer ? msg('sec.x509.section.3') : msg('sec.x509.section.4');
      out.push(joinBlocks([
        section(msg('sec.x509.section.1', { p0: index + 1, parsed: parsed.length, section: chainLabel })),
        alignRows(await certSummary(msg, cert, item.pem)),
        section(msg('sec.x509.section.5')), alignRows(parseDn(msg, subject)),
        section(msg('sec.x509.section.6')), alignRows(parseDn(msg, issuer)),
        section(msg('sec.x509.section.7')), alignRows(validityRows(msg, locale, cert)),
        section(msg('sec.x509.section.8')), sans.length ? alignRows(sans) : alignRows([[msg('sec.x509.section.9'), msg('sec.x509.section.10')]]),
        section(msg('sec.x509.section.11')), alignRows(extensionRows(msg, cert, sans)),
        section(msg('sec.x509.section.12')),
        alignRows([
          [msg('sec.x509.row.2'), subject === issuer ? msg('sec.x509.row.3') : msg('common.value.no')],
          [msg('sec.x509.row.5'), basic === undefined ? `${msg('sec.x509.row.8')}${String(false)}` : basic.cA === true ? msg('sec.x509.row.6') : msg('sec.x509.row.7', { FALSE: 'CA:FALSE' })],
          [msg('sec.x509.row.9'), msg('sec.x509.row.10', { DAY_MS: ((notAfter - Date.now()) / DAY_MS).toFixed(2), now: relativePhrase(notAfter - Date.now(), phraseLocale(locale, 'zh-CN')) })],
          [msg('sec.x509.row.11'), index === 0 && parsed.length > 1 ? msg('sec.x509.row.12', { section: dn(parsed[1]!.cert.issuer) === subject ? msg('sec.x509.row.13') : msg('sec.x509.section.13') }) : '—'],
        ]),
        ...(showChain ? [section(msg('sec.x509.section.14')), item.pem] : []),
      ]));
    }
    if (output === 'full-json') {
      const payload = shown.map((item) => jsonOf(msg, item.cert, item.pem, sanEntries(msg, item.cert)));
      for (const [index, item] of shown.entries()) {
        const summary = payload[index]!;
        summary.fingerprintSha1 = await fingerprint(item.der, 'SHA-1');
        summary.fingerprintSha256 = await fingerprint(item.der, 'SHA-256');
        summary.fingerprintSha512 = await fingerprint(item.der, 'SHA-512');
      }
      await ctx.emit({ name: 'x509.json', kind: 'json', bytes: new TextEncoder().encode(`${JSON.stringify(payload.length === 1 ? payload[0] : payload, null, 2)}\n`) });
      out.unshift(joinBlocks([section(msg('sec.x509.section.15')), msg('sec.x509.section.16', { payload: payload.length })]));
    }
    out.push(joinBlocks([section(msg('common.section.notes')), [
      msg('sec.x509.text.1'), msg('sec.x509.text.2'), msg('sec.x509.text.3'), msg('sec.x509.text.4'),
      showChain ? msg('sec.x509.text.5', { parsed: parsed.length }) : msg('sec.x509.text.6', { parsed: parsed.length }),
      output === 'full-json' ? msg('sec.x509.text.7') : msg('sec.x509.text.8'),
    ].join('\n')]));
    if (warnings.length) out.push(joinBlocks([section(msg('sec.password.section.1')), warnings.map((warning) => `· ${warning}`).join('\n')]));
    await emitText(ctx, 'x509.txt', out.join('\n\n'));
    ctx.report({ percent: 100, phase: 'done' });
    const primaryDer = parsed[0]!.der;
    return { extra: { certs: shown.length, total: parsed.length, subject: dn(primary.subject).replace(/\s+/g, ''), serial: serialNumber(primary), fingerprint256: await fingerprint(primaryDer, 'SHA-256'), expired: Date.now() > primary.validity.notAfter.getTime() ? 'yes' : 'no', output } };
  },
};
