import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import bcrypt from 'bcryptjs';
import { EngineError } from '../errors.ts';
import { localeOf, makeMsg } from '../lib/messages.ts';
import type { ToolContext, ToolImpl } from '../types.ts';
import { emitText, optBool, optNum, optStr } from './time-core.ts';

type Msg = ReturnType<typeof makeMsg>;
const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64(payload: string): Uint8Array {
  const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) {
    throw new Error('Invalid base64');
  }
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (encodeBase64(bytes).replace(/=+$/, '') !== normalized.replace(/=+$/, '')) {
    throw new Error('Invalid base64');
  }
  return bytes;
}

function fail(msg: Msg, key: string): never {
  throw new EngineError('bad_request', msg(key));
}

function inputOf(ctx: ToolContext, msg: Msg): string {
  const input = optStr(ctx, 'input');
  if (!input.trim()) fail(msg, 'dev.error.empty');
  return input;
}

function xmlParse(input: string, msg: Msg): Record<string, unknown> {
  const valid = XMLValidator.validate(input);
  if (valid !== true) fail(msg, 'dev.error.xml');
  return new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text', parseTagValue: false, trimValues: false }).parse(input) as Record<string, unknown>;
}

const jsonFormat: ToolImpl = {
  id: 'json-format',
  async run(ctx) {
    const msg = makeMsg(localeOf(ctx));
    const source = inputOf(ctx, msg);
    let value: unknown;
    try { value = JSON.parse(source); } catch { fail(msg, 'dev.error.json'); }
    const mode = optStr(ctx, 'mode') === 'minify' ? 'minify' : 'pretty';
    const indent = Math.max(1, Math.min(8, Math.trunc(optNum(ctx, 'indent', 2))));
    const text = JSON.stringify(value, null, mode === 'minify' ? undefined : indent);
    await emitText(ctx, 'json-formatted.json', text);
    return { extra: { mode, inputBytes: byteLength(source), outputBytes: byteLength(text) } };
  },
};

const xmlFormat: ToolImpl = {
  id: 'xml-format',
  async run(ctx) {
    const msg = makeMsg(localeOf(ctx));
    const source = inputOf(ctx, msg);
    const parsed = xmlParse(source, msg);
    const mode = optStr(ctx, 'mode') === 'minify' ? 'minify' : 'pretty';
    const text = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@_', format: mode === 'pretty', indentBy: '  ', suppressEmptyNode: false }).build(parsed);
    await emitText(ctx, 'xml-formatted.xml', text);
    return { extra: { mode, inputBytes: byteLength(source), outputBytes: byteLength(text) } };
  },
};

const xmlJson: ToolImpl = {
  id: 'xml-json',
  async run(ctx) {
    const msg = makeMsg(localeOf(ctx));
    const source = inputOf(ctx, msg);
    const direction = optStr(ctx, 'direction');
    let text: string;
    if (direction === 'json-xml') {
      let value: unknown;
      try { value = JSON.parse(source); } catch { fail(msg, 'dev.error.json'); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail(msg, 'dev.error.jsonRoot');
      text = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@_', format: true, indentBy: '  ' }).build(value);
    } else {
      text = JSON.stringify(xmlParse(source, msg), null, 2);
    }
    await emitText(ctx, direction === 'json-xml' ? 'converted.xml' : 'converted.json', text);
    return { extra: { direction, outputBytes: byteLength(text) } };
  },
};

const yamlJson: ToolImpl = {
  id: 'yaml-json',
  async run(ctx) {
    const msg = makeMsg(localeOf(ctx));
    const source = inputOf(ctx, msg);
    const direction = optStr(ctx, 'direction');
    let text: string;
    try {
      if (direction === 'json-yaml') {
        text = stringifyYaml(JSON.parse(source));
      } else {
        text = JSON.stringify(parseYaml(source), null, 2);
      }
    } catch {
      fail(msg, direction === 'json-yaml' ? 'dev.error.json' : 'dev.error.yaml');
    }
    await emitText(ctx, direction === 'json-yaml' ? 'converted.yaml' : 'converted.json', text);
    return { extra: { direction, outputBytes: byteLength(text) } };
  },
};

const regexTest: ToolImpl = {
  id: 'regex-test',
  async run(ctx) {
    const msg = makeMsg(localeOf(ctx));
    const pattern = optStr(ctx, 'pattern');
    const source = inputOf(ctx, msg);
    const flags = optStr(ctx, 'flags');
    const mode = optStr(ctx, 'mode') === 'replace' ? 'replace' : 'test';
    if (!pattern) fail(msg, 'dev.error.regex');
    if (source.length > 1_000_000) fail(msg, 'dev.error.tooLarge');
    try {
      const { Script } = await import(/* @vite-ignore */ 'node:vm');
      const script = mode === 'replace'
        ? new Script('new RegExp(pattern, flags); source.replace(new RegExp(pattern, flags), replacement)')
        : new Script('const scanFlags = flags.includes("g") ? flags : flags + "g"; [...source.matchAll(new RegExp(pattern, scanFlags))].slice(0, 1000).map((match) => ({ value: match[0], index: match.index, groups: match.slice(1) }))');
      const result = script.runInNewContext({ pattern, flags, source, replacement: optStr(ctx, 'replacement') }, { timeout: 150 }) as string | Array<{ value: string; index: number; groups: string[] }>;
      const matches = mode === 'replace' ? [] : result as Array<{ value: string; index: number; groups: string[] }>;
      const text = mode === 'replace'
        ? String(result)
        : matches.length
          ? matches.map((match, index) => `${index + 1}. ${JSON.stringify(match.value)} @ ${match.index}${match.groups.length ? `  (${match.groups.map((group) => JSON.stringify(group)).join(', ')})` : ''}`).join('\n')
          : msg('dev.regex.noMatches');
      await emitText(ctx, 'regex-result.txt', text);
      return { extra: { mode, matches: matches.length } };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      fail(msg, code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ? 'dev.error.regexTimeout' : 'dev.error.regex');
    }
  },
};

const binaryCodec: ToolImpl = {
  id: 'binary-codec',
  async run(ctx) {
    const msg = makeMsg(localeOf(ctx));
    const source = inputOf(ctx, msg);
    const direction = optStr(ctx, 'direction');
    let text: string;
    if (direction === 'binary-text') {
      const groups = source.trim().split(/[\s,]+/);
      if (!groups.length || groups.some((bit) => !/^[01]{8}$/.test(bit))) fail(msg, 'dev.error.binary');
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(groups, (bit) => Number.parseInt(bit, 2))); }
      catch { fail(msg, 'dev.error.binaryUtf8'); }
    } else {
      text = [...new TextEncoder().encode(source)].map((byte) => byte.toString(2).padStart(8, '0')).join(' ');
    }
    await emitText(ctx, 'binary-conversion.txt', text);
    return { extra: { direction, characters: [...text].length } };
  },
};

function wordsOf(input: string): string[] {
  return input
    .replace(/([\p{Ll}\d])([\p{Lu}])/gu, '$1 $2')
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

const caseConvert: ToolImpl = {
  id: 'case-convert',
  async run(ctx) {
    const msg = makeMsg(localeOf(ctx));
    const source = inputOf(ctx, msg);
    const words = wordsOf(source);
    if (!words.length) fail(msg, 'dev.error.empty');
    const lower = words.map((word) => word.toLocaleLowerCase());
    const cap = (word: string) => word ? word[0]!.toLocaleUpperCase() + word.slice(1) : '';
    const style = optStr(ctx, 'style');
    const text = style === 'upper' ? source.toLocaleUpperCase()
      : style === 'lower' ? source.toLocaleLowerCase()
        : style === 'title' ? lower.map(cap).join(' ')
          : style === 'pascal' ? lower.map(cap).join('')
            : style === 'snake' ? lower.join('_')
              : style === 'kebab' ? lower.join('-')
                : lower[0]! + lower.slice(1).map(cap).join('');
    await emitText(ctx, 'converted-case.txt', text);
    return { extra: { style, words: words.length } };
  },
};

function uaDetails(ua: string): [string, string, string] {
  const browser = ua.match(/Edg(?:e|A|iOS)?\/([\d.]+)/i) ? `Microsoft Edge ${ua.match(/Edg(?:e|A|iOS)?\/([\d.]+)/i)![1]}`
    : ua.match(/(?:OPR|Opera)\/([\d.]+)/i) ? `Opera ${ua.match(/(?:OPR|Opera)\/([\d.]+)/i)![1]}`
      : ua.match(/Firefox\/([\d.]+)/i) ? `Firefox ${ua.match(/Firefox\/([\d.]+)/i)![1]}`
        : ua.match(/(?:CriOS|Chrome)\/([\d.]+)/i) ? `Chrome ${ua.match(/(?:CriOS|Chrome)\/([\d.]+)/i)![1]}`
          : ua.match(/Version\/([\d.]+).*Safari/i) ? `Safari ${ua.match(/Version\/([\d.]+).*Safari/i)![1]}` : 'Unknown';
  const os = /Windows NT 10/i.test(ua) ? 'Windows 10/11'
    : /Windows NT 6\.1/i.test(ua) ? 'Windows 7'
      : /Android ([\d.]+)/i.test(ua) ? `Android ${ua.match(/Android ([\d.]+)/i)![1]}`
        : /iPhone|iPad|iPod/i.test(ua) ? 'iOS / iPadOS'
          : /Mac OS X ([\d_]+)/i.test(ua) ? `macOS ${ua.match(/Mac OS X ([\d_]+)/i)![1]!.replace(/_/g, '.')}`
            : /Linux/i.test(ua) ? 'Linux' : 'Unknown';
  const device = /iPad/i.test(ua) ? 'Tablet'
    : /Mobile|iPhone|Android/i.test(ua) ? 'Mobile'
      : /Windows|Macintosh|X11|Linux/i.test(ua) ? 'Desktop' : 'Unknown';
  return [browser, os, device];
}

const userAgent: ToolImpl = {
  id: 'user-agent',
  async run(ctx) {
    const msg = makeMsg(localeOf(ctx));
    const source = inputOf(ctx, msg).trim();
    const [browser, os, device] = uaDetails(source);
    const text = `${msg('dev.ua.browser')}: ${browser}\n${msg('dev.ua.os')}: ${os}\n${msg('dev.ua.device')}: ${device}\n\n${msg('dev.ua.raw')}:\n${source}`;
    await emitText(ctx, 'user-agent.txt', text);
    return { extra: { browser, os, device } };
  },
};

function ipv4Number(input: string, msg: Msg): number {
  const parts = input.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) fail(msg, 'dev.error.ipv4');
  return parts.reduce((value, part) => value * 256 + Number(part), 0) >>> 0;
}

function ipv4Text(value: number): string {
  const n = value >>> 0;
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

const ipv4Convert: ToolImpl = {
  id: 'ipv4-convert',
  async run(ctx) {
    const msg = makeMsg(localeOf(ctx));
    const source = inputOf(ctx, msg).trim();
    const value = ipv4Number(source, msg);
    const text = [
      `${msg('dev.ipv4.address')}: ${source}`,
      `${msg('dev.ipv4.decimal')}: ${value}`,
      `${msg('dev.ipv4.hex')}: 0x${value.toString(16).padStart(8, '0').toUpperCase()}`,
      `${msg('dev.ipv4.binary')}: ${[value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].map((part) => part.toString(2).padStart(8, '0')).join('.')}`,
    ].join('\n');
    await emitText(ctx, 'ipv4-conversion.txt', text);
    return { extra: { decimal: value, hex: value.toString(16).padStart(8, '0') } };
  },
};

const ipv4Subnet: ToolImpl = {
  id: 'ipv4-subnet',
  async run(ctx) {
    const msg = makeMsg(localeOf(ctx));
    const [address, rawPrefix] = inputOf(ctx, msg).trim().split('/');
    const ip = ipv4Number(address ?? '', msg);
    const prefix = rawPrefix === undefined ? 24 : Number(rawPrefix);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) fail(msg, 'dev.error.cidr');
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    const network = (ip & mask) >>> 0;
    const broadcast = (network | (~mask >>> 0)) >>> 0;
    const hostBits = 32 - prefix;
    const hostCount = prefix === 32 ? 1 : prefix === 31 ? 2 : Math.max(0, 2 ** hostBits - 2);
    const first = prefix >= 31 ? network : network + 1;
    const last = prefix >= 31 ? broadcast : broadcast - 1;
    const text = [
      `${msg('dev.ipv4.input')}: ${ipv4Text(ip)}/${prefix}`,
      `${msg('dev.ipv4.network')}: ${ipv4Text(network)}`,
      `${msg('dev.ipv4.mask')}: ${ipv4Text(mask)}`,
      `${msg('dev.ipv4.broadcast')}: ${ipv4Text(broadcast)}`,
      `${msg('dev.ipv4.usable')}: ${ipv4Text(first)} – ${ipv4Text(last)}`,
      `${msg('dev.ipv4.hostCount')}: ${hostCount}`,
    ].join('\n');
    await emitText(ctx, 'ipv4-subnet.txt', text);
    return { extra: { prefix, network: ipv4Text(network), broadcast: ipv4Text(broadcast), hostCount } };
  },
};

function colorRgb(input: string, msg: Msg): [number, number, number] {
  const source = input.trim();
  const hex = source.match(/^#?([\da-f]{3}|[\da-f]{6})$/i)?.[1];
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((char) => char + char).join('') : hex;
    return [0, 2, 4].map((index) => Number.parseInt(full.slice(index, index + 2), 16)) as [number, number, number];
  }
  const rgb = source.match(/^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i);
  if (rgb) {
    const channels = rgb.slice(1).map(Number);
    if (channels.every((channel) => channel <= 255)) return channels as [number, number, number];
  }
  fail(msg, 'dev.error.color');
}

function rgbToHsl([r0, g0, b0]: [number, number, number]): [number, number, number] {
  const r = r0 / 255, g = g0 / 255, b = b0 / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  const l = (max + min) / 2;
  let s = 0;
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
}

const colorConvert: ToolImpl = {
  id: 'color-convert',
  async run(ctx) {
    const msg = makeMsg(localeOf(ctx));
    const [r, g, b] = colorRgb(inputOf(ctx, msg), msg);
    const hex = `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
    const [h, s, l] = rgbToHsl([r, g, b]);
    const text = `HEX: ${hex}\nRGB: rgb(${r}, ${g}, ${b})\nHSL: hsl(${h}, ${s}%, ${l}%)`;
    await emitText(ctx, 'color-values.txt', text);
    return { extra: { hex, red: r, green: g, blue: b } };
  },
};

const bcryptTool: ToolImpl = {
  id: 'bcrypt',
  async run(ctx) {
    const msg = makeMsg(localeOf(ctx));
    const mode = optStr(ctx, 'mode') === 'verify' ? 'verify' : 'hash';
    const password = optStr(ctx, 'bcryptPassword');
    if (!password) fail(msg, 'dev.error.empty');
    if (byteLength(password) > 72) fail(msg, 'dev.error.bcryptLength');
    if (mode === 'hash') {
      const rounds = Math.max(4, Math.min(12, Math.trunc(optNum(ctx, 'rounds', 10))));
      const hash = await bcrypt.hash(password, rounds);
      await emitText(ctx, 'bcrypt-hash.txt', hash);
      return { extra: { mode, rounds, valid: '' } };
    }
    const hash = optStr(ctx, 'bcryptHash');
    if (!/^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$/.test(hash)) fail(msg, 'dev.error.bcryptHash');
    const valid = await bcrypt.compare(password, hash);
    await emitText(ctx, 'bcrypt-verification.txt', msg(valid ? 'dev.bcrypt.match' : 'dev.bcrypt.noMatch'));
    return { extra: { mode, rounds: '', valid: valid ? 1 : 0 } };
  },
};

function linesOf(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

const robotsTxt: ToolImpl = {
  id: 'robots-txt',
  async run(ctx) {
    const msg = makeMsg(localeOf(ctx));
    const agent = optStr(ctx, 'userAgent').trim() || '*';
    const allow = linesOf(optStr(ctx, 'allow'));
    const disallow = linesOf(optStr(ctx, 'disallow'));
    const sitemap = optStr(ctx, 'sitemap').trim();
    if (sitemap) {
      try { const url = new URL(sitemap); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); }
      catch { fail(msg, 'dev.error.sitemap'); }
    }
    const lines = [`User-agent: ${agent}`, ...allow.map((path) => `Allow: ${path.startsWith('/') ? path : `/${path}`}`), ...disallow.map((path) => `Disallow: ${path.startsWith('/') ? path : `/${path}`}`), ...(sitemap ? ['', `Sitemap: ${sitemap}`] : [])];
    const text = lines.join('\n');
    await emitText(ctx, 'robots.txt', text);
    return { extra: { rules: allow.length + disallow.length } };
  },
};

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z]{2,63}$/i;

const spfRecord: ToolImpl = {
  id: 'spf-record',
  async run(ctx) {
    const msg = makeMsg(localeOf(ctx));
    const domain = optStr(ctx, 'domain').trim();
    if (!DOMAIN_RE.test(domain)) fail(msg, 'dev.error.domain');
    const includes = linesOf(optStr(ctx, 'includes'));
    const ips = linesOf(optStr(ctx, 'ipv4'));
    const terms: string[] = ['v=spf1'];
    if (optBool(ctx, 'mx', false)) terms.push('mx');
    if (optBool(ctx, 'a', false)) terms.push('a');
    for (const item of ips) {
      const cidr = item.split('/');
      ipv4Number(cidr[0] ?? '', msg);
      if (cidr[1] !== undefined && (!/^\d+$/.test(cidr[1]) || Number(cidr[1]) > 32)) fail(msg, 'dev.error.cidr');
      terms.push(`ip4:${item}`);
    }
    for (const item of includes) {
      const include = item.replace(/^include:/i, '');
      if (!DOMAIN_RE.test(include)) fail(msg, 'dev.error.domain');
      terms.push(`include:${include}`);
    }
    if (includes.length + Number(optBool(ctx, 'mx', false)) + Number(optBool(ctx, 'a', false)) > 10) fail(msg, 'dev.error.spfLookups');
    terms.push(optStr(ctx, 'policy') || '-all');
    const text = terms.join(' ');
    await emitText(ctx, 'spf-record.txt', text);
    return { extra: { domain, terms: terms.length } };
  },
};

const dmarcRecord: ToolImpl = {
  id: 'dmarc-record',
  async run(ctx) {
    const msg = makeMsg(localeOf(ctx));
    const domain = optStr(ctx, 'domain').trim();
    if (!DOMAIN_RE.test(domain)) fail(msg, 'dev.error.domain');
    const email = optStr(ctx, 'reportEmail').trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(msg, 'dev.error.email');
    const percent = Math.max(0, Math.min(100, Math.trunc(optNum(ctx, 'percent', 100))));
    const policy = ['none', 'quarantine', 'reject'].includes(optStr(ctx, 'policy')) ? optStr(ctx, 'policy') : 'quarantine';
    const text = [`${msg('dev.dmarc.host')}: _dmarc.${domain}`, `${msg('dev.dmarc.value')}: v=DMARC1; p=${policy}; pct=${percent}${email ? `; rua=mailto:${email}` : ''}`].join('\n');
    await emitText(ctx, 'dmarc-record.txt', text);
    return { extra: { domain, policy, percent } };
  },
};

const fileBase64: ToolImpl = {
  id: 'file-base64',
  async run(ctx) {
    if (!ctx.inputs.length) throw new EngineError('empty_selection', makeMsg(localeOf(ctx))('dev.error.empty'));
    const file = ctx.inputs[0]!;
    if (file.bytes.byteLength > 8 * 1024 * 1024) fail(makeMsg(localeOf(ctx)), 'dev.error.tooLarge');
    const encoded = encodeBase64(file.bytes);
    await ctx.emit({ name: `${file.name}.base64.txt`, kind: 'text', bytes: new TextEncoder().encode(encoded) });
    return { extra: { sourceBytes: file.bytes.byteLength, encodedCharacters: encoded.length } };
  },
};

const base64File: ToolImpl = {
  id: 'base64-file',
  async run(ctx) {
    const msg = makeMsg(localeOf(ctx));
    const source = inputOf(ctx, msg).trim();
    const name = (optStr(ctx, 'filename') || 'decoded.bin').trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'decoded.bin';
    const payload = source.replace(/^data:[^,]*;base64,/i, '').replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    if (payload.length > 12 * 1024 * 1024) fail(msg, 'dev.error.tooLarge');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload) || payload.length % 4 === 1) fail(msg, 'dev.error.base64');
    let bytes: Uint8Array;
    try { bytes = decodeBase64(payload); } catch { fail(msg, 'dev.error.base64'); }
    await ctx.emit({ name, kind: 'binary', bytes });
    return { extra: { filename: name, bytes: bytes.byteLength } };
  },
};

const dnsLookup: ToolImpl = {
  id: 'dns-lookup',
  async run(ctx) {
    const msg = makeMsg(localeOf(ctx));
    const hostname = optStr(ctx, 'hostname').replace(/\.$/, '').toLowerCase();
    const labels = hostname.split('.');
    if (!hostname || hostname.length > 253 || labels.some((label) => label.length > 63 || !/^[a-z\d_-]+$/i.test(label) || label.startsWith('-') || label.endsWith('-'))) fail(msg, 'dev.error.hostname');
    const type = optStr(ctx, 'recordType').toUpperCase();
    const { Resolver } = await import(/* @vite-ignore */ 'node:dns/promises');
    const resolver = new Resolver({ timeout: 2500, tries: 1 });
    const method = ({ A: 'resolve4', AAAA: 'resolve6', MX: 'resolveMx', TXT: 'resolveTxt', NS: 'resolveNs', CNAME: 'resolveCname', SOA: 'resolveSoa' } as const)[type as 'A' | 'AAAA' | 'MX' | 'TXT' | 'NS' | 'CNAME' | 'SOA'];
    if (!method) fail(msg, 'dev.error.dnsType');
    try {
      const response: unknown = await resolver[method](hostname);
      const records: unknown[] = Array.isArray(response) ? response : [response];
      const lines = records.map((record) => Array.isArray(record) ? record.join('') : typeof record === 'object' ? JSON.stringify(record) : String(record));
      await emitText(ctx, `dns-${type.toLowerCase()}-records.txt`, lines.join('\n'));
      return { extra: { hostname, type, count: lines.length } };
    } catch {
      fail(msg, 'dev.error.dnsLookup');
    } finally {
      resolver.cancel();
    }
  },
};

/** Desktop Worker implementation: DNS over HTTPS keeps lookup inside the EXE. */
const embeddedDnsLookup: ToolImpl = {
  id: 'dns-lookup',
  async run(ctx) {
    const msg = makeMsg(localeOf(ctx));
    const hostname = optStr(ctx, 'hostname').replace(/\.$/, '').toLowerCase();
    const labels = hostname.split('.');
    if (!hostname || hostname.length > 253 || labels.some((label) => label.length > 63 || !/^[a-z\d_-]+$/i.test(label) || label.startsWith('-') || label.endsWith('-'))) fail(msg, 'dev.error.hostname');
    const type = optStr(ctx, 'recordType').toUpperCase();
    if (!['A', 'AAAA', 'MX', 'TXT', 'NS', 'CNAME', 'SOA'].includes(type)) fail(msg, 'dev.error.dnsType');

    const native = ctx.runtimeData?.nativeDns as { hostname?: string; recordType?: string; records?: string[] } | undefined;
    let rawRecords: string[];
    try {
      if (native?.hostname === hostname && native.recordType === type && Array.isArray(native.records)) {
        rawRecords = native.records;
      } else {
        // Browser-only use has no Tauri host, so it retains the public DoH path.
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2500);
        try {
          const endpoint = new URL('https://dns.google/resolve');
          endpoint.searchParams.set('name', hostname);
          endpoint.searchParams.set('type', type);
          const response = await fetch(endpoint, { headers: { accept: 'application/dns-json' }, signal: controller.signal });
          if (!response.ok) fail(msg, 'dev.error.dnsLookup');
          const payload = await response.json() as { Status?: number; Answer?: Array<{ type?: number; data?: string }> };
          if (payload.Status !== 0 || !Array.isArray(payload.Answer)) fail(msg, 'dev.error.dnsLookup');
          const typeCode: Record<string, number> = { A: 1, NS: 2, CNAME: 5, SOA: 6, MX: 15, TXT: 16, AAAA: 28 };
          rawRecords = payload.Answer
            .filter((answer) => answer.type === typeCode[type] && typeof answer.data === 'string')
            .map((answer) => answer.data!);
        } finally {
          clearTimeout(timeout);
        }
      }
      if (!rawRecords.length) fail(msg, 'dev.error.dnsLookup');
      const lines = rawRecords.map((record) => {
        const data = record;
        if (type === 'TXT') {
          const chunks = data.match(/"(?:\\.|[^"\\])*"/g);
          return chunks ? chunks.map((chunk) => chunk.slice(1, -1)
            .replace(/\\(\d{3})/g, (_match, octal: string) => String.fromCharCode(Number(octal)))
            .replace(/\\([\\"])/g, '$1')).join('') : data;
        }
        if (type === 'MX') {
          const [priority, ...exchange] = data.trim().split(/\s+/);
          return JSON.stringify({ exchange: exchange.join('').replace(/\.$/, ''), priority: Number(priority) });
        }
        if (type === 'SOA') {
          const [nsname, hostmaster, serial, refresh, retry, expire, minttl] = data.trim().split(/\s+/);
          return JSON.stringify({ nsname: nsname?.replace(/\.$/, ''), hostmaster: hostmaster?.replace(/\.$/, ''), serial: Number(serial), refresh: Number(refresh), retry: Number(retry), expire: Number(expire), minttl: Number(minttl) });
        }
        return ['NS', 'CNAME'].includes(type) ? data.replace(/\.$/, '') : data;
      });
      await emitText(ctx, `dns-${type.toLowerCase()}-records.txt`, lines.join('\n'));
      return { extra: { hostname, type, count: lines.length } };
    } catch (error) {
      if (error instanceof EngineError) throw error;
      fail(msg, 'dev.error.dnsLookup');
    }
  },
};

const embeddedSystemNetwork: ToolImpl = {
  id: 'system-network',
  async run(ctx) {
    const msg = makeMsg(localeOf(ctx));
    const probe = ctx.runtimeData?.nativeNetwork as { kind?: string; stdout?: string; stderr?: string; dnsServers?: string; interfaceCount?: number } | undefined;
    if (probe?.kind !== 'system-network') fail(msg, 'dev.error.networkUnavailable');
    const lines = [`${msg('dev.localNetwork.dns')}: ${probe.dnsServers || '—'}`, probe.stdout?.trim(), probe.stderr?.trim()].filter(Boolean);
    await emitText(ctx, 'local-network-info.txt', lines.join('\n\n'));
    return { extra: { interfaces: probe.interfaceCount ?? 0 } };
  },
};

const embeddedPingCheck: ToolImpl = {
  id: 'ping-check',
  async run(ctx) {
    const msg = makeMsg(localeOf(ctx));
    const host = optStr(ctx, 'host');
    if (!hostIsValid(host)) fail(msg, 'dev.error.hostname');
    const count = Math.max(1, Math.min(10, Math.trunc(optNum(ctx, 'count', 4))));
    const result = ctx.runtimeData?.nativeNetwork as { kind?: string; stdout?: string; stderr?: string; errorCode?: string | null; connected?: boolean } | undefined;
    if (result?.kind !== 'ping-check') fail(msg, 'dev.error.networkUnavailable');
    if (result.errorCode === 'ENOENT') fail(msg, 'dev.error.pingUnavailable');
    const reachable = result.connected === true;
    const report = [`${msg('dev.localNetwork.target')}: ${host}`, `${msg('dev.localNetwork.status')}: ${msg(reachable ? 'dev.localNetwork.reachable' : 'dev.localNetwork.unreachable')}`, '', (result.stdout || result.stderr || result.errorCode || '').trim()].filter(Boolean).join('\n');
    await emitText(ctx, 'ping-result.txt', report);
    return { extra: { reachable: reachable ? 1 : 0, count } };
  },
};

const embeddedTcpCheck: ToolImpl = {
  id: 'tcp-check',
  async run(ctx) {
    const msg = makeMsg(localeOf(ctx));
    const host = optStr(ctx, 'host');
    const port = Math.trunc(optNum(ctx, 'port', 0));
    if (!hostIsValid(host)) fail(msg, 'dev.error.hostname');
    if (port < 1 || port > 65535) fail(msg, 'dev.error.port');
    const result = ctx.runtimeData?.nativeNetwork as { kind?: string; errorCode?: string | null; connected?: boolean; elapsedMs?: number } | undefined;
    if (result?.kind !== 'tcp-check') fail(msg, 'dev.error.networkUnavailable');
    const connected = result.connected === true;
    const elapsed = result.elapsedMs ?? 0;
    const status = connected ? 'dev.localNetwork.connected' : result.errorCode === 'ETIMEDOUT' ? 'dev.localNetwork.timeout' : 'dev.localNetwork.refused';
    const report = [`${msg('dev.localNetwork.target')}: ${host}:${port}`, `${msg('dev.localNetwork.status')}: ${msg(status)}`, `${msg('dev.localNetwork.elapsed')}: ${elapsed} ms`, ...(result.errorCode && result.errorCode !== 'ETIMEDOUT' ? [`${msg('dev.localNetwork.errorCode')}: ${result.errorCode}`] : [])].join('\n');
    await emitText(ctx, 'tcp-connection-result.txt', report);
    return { extra: { connected: connected ? 1 : 0, elapsedMs: elapsed } };
  },
};

const urlInspect: ToolImpl = {
  id: 'url-inspect',
  async run(ctx) {
    const msg = makeMsg(localeOf(ctx));
    let url: URL;
    try {
      url = new URL(optStr(ctx, 'url'));
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error();
    } catch { fail(msg, 'dev.error.url'); }
    const entries = [...url.searchParams.entries()];
    const rows = [
      `${msg('dev.network.protocol')}: ${url.protocol.slice(0, -1)}`,
      `${msg('dev.network.hostname')}: ${url.hostname}`,
      `${msg('dev.network.port')}: ${url.port || (url.protocol === 'https:' ? '443 (default)' : '80 (default)')}`,
      `${msg('dev.network.path')}: ${url.pathname}`,
      `${msg('dev.network.query')}: ${entries.length ? entries.map(([key, value]) => `${key} = ${value}`).join('\n  ') : '—'}`,
      `${msg('dev.network.fragment')}: ${url.hash.slice(1) || '—'}`,
    ];
    await emitText(ctx, 'url-analysis.txt', rows.join('\n'));
    return { extra: { hostname: url.hostname, parameters: entries.length } };
  },
};

function ipv6Groups(input: string, msg: Msg): number[] {
  if (!isIPv6Address(input)) fail(msg, 'dev.error.ipv6');
  let source = input.toLowerCase();
  const ipv4 = source.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (ipv4) {
    const bytes = ipv4[1]!.split('.').map(Number);
    if (bytes.some((byte) => byte > 255)) fail(msg, 'dev.error.ipv6');
    const pair = `${((bytes[0]! << 8) | bytes[1]!).toString(16)}:${((bytes[2]! << 8) | bytes[3]!).toString(16)}`;
    source = source.slice(0, -ipv4[1]!.length) + pair;
  }
  const halves = source.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  const groups = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right].map((group) => Number.parseInt(group, 16));
  if (groups.length !== 8 || groups.some((group) => !Number.isFinite(group) || group > 0xffff)) fail(msg, 'dev.error.ipv6');
  return groups;
}

function isIPv6Address(input: string): boolean {
  if (!input || input.includes('%') || input.includes(':::')) return false;
  let source = input;
  const ipv4 = source.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (ipv4) {
    const octets = ipv4[1]!.split('.');
    if (octets.some((octet) => Number(octet) > 255)) return false;
    source = `${source.slice(0, -ipv4[1]!.length)}${((Number(octets[0]) << 8) | Number(octets[1])).toString(16)}:${((Number(octets[2]) << 8) | Number(octets[3])).toString(16)}`;
  }
  const halves = source.split('::');
  if (halves.length > 2) return false;
  if (halves.length === 1 && (source.startsWith(':') || source.endsWith(':'))) return false;
  const groups = source.split(':').filter(Boolean);
  if (groups.some((group) => group.length > 4 || !/^[\da-f]+$/i.test(group))) return false;
  return halves.length === 2 ? groups.length < 8 : groups.length === 8;
}

const ipv6Convert: ToolImpl = {
  id: 'ipv6-convert',
  async run(ctx) {
    const msg = makeMsg(localeOf(ctx));
    const source = optStr(ctx, 'input');
    const groups = ipv6Groups(source, msg);
    const expanded = groups.map((group) => group.toString(16).padStart(4, '0')).join(':');
    let bestStart = -1, bestLength = 1;
    for (let i = 0; i < groups.length;) {
      if (groups[i] !== 0) { i++; continue; }
      let end = i;
      while (end < groups.length && groups[end] === 0) end++;
      if (end - i > bestLength) { bestStart = i; bestLength = end - i; }
      i = end;
    }
    const compactGroups = groups.map((group) => group.toString(16));
    const compressed = bestStart < 0 ? compactGroups.join(':')
      : `${compactGroups.slice(0, bestStart).join(':')}::${compactGroups.slice(bestStart + bestLength).join(':')}`;
    const text = `${msg('dev.network.ipv6.input')}: ${source}\n${msg('dev.network.ipv6.compressed')}: ${compressed}\n${msg('dev.network.ipv6.expanded')}: ${expanded}`;
    await emitText(ctx, 'ipv6-conversion.txt', text);
    return { extra: { compressed, expanded } };
  },
};

const KNOWN_PORTS: Record<number, [string, string, string]> = {
  20: ['FTP data', 'TCP', 'File transfer data channel'], 21: ['FTP control', 'TCP', 'File transfer control channel'],
  22: ['SSH', 'TCP', 'Secure shell'], 23: ['Telnet', 'TCP', 'Unencrypted remote terminal'],
  25: ['SMTP', 'TCP', 'Mail transfer'], 53: ['DNS', 'TCP/UDP', 'Domain name system'],
  67: ['DHCP server', 'UDP', 'Dynamic host configuration'], 68: ['DHCP client', 'UDP', 'Dynamic host configuration'],
  80: ['HTTP', 'TCP', 'Web traffic'], 110: ['POP3', 'TCP', 'Mail retrieval'], 123: ['NTP', 'UDP', 'Network time'],
  143: ['IMAP', 'TCP', 'Mail retrieval'], 161: ['SNMP', 'UDP', 'Network management'], 389: ['LDAP', 'TCP', 'Directory service'],
  443: ['HTTPS', 'TCP', 'Encrypted web traffic'], 445: ['SMB', 'TCP', 'Windows file sharing'], 465: ['SMTPS', 'TCP', 'SMTP over implicit TLS'],
  587: ['SMTP submission', 'TCP', 'Mail submission'], 993: ['IMAPS', 'TCP', 'IMAP over TLS'], 995: ['POP3S', 'TCP', 'POP3 over TLS'],
  1433: ['Microsoft SQL Server', 'TCP', 'Database service'], 3306: ['MySQL', 'TCP', 'Database service'], 3389: ['RDP', 'TCP', 'Remote desktop'],
  5432: ['PostgreSQL', 'TCP', 'Database service'], 6379: ['Redis', 'TCP', 'In-memory data store'], 8080: ['HTTP alternate', 'TCP', 'Common alternate web port'],
  8443: ['HTTPS alternate', 'TCP', 'Common alternate secure web port'], 27017: ['MongoDB', 'TCP', 'Database service'],
};

const portReference: ToolImpl = {
  id: 'port-reference',
  async run(ctx) {
    const msg = makeMsg(localeOf(ctx));
    const port = Number(optStr(ctx, 'port'));
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail(msg, 'dev.error.port');
    const info = KNOWN_PORTS[port];
    const text = info
      ? `${msg('dev.network.port')}: ${port}\n${msg('dev.network.port.service')}: ${info[0]}\n${msg('dev.network.port.transport')}: ${info[1]}\n${msg('dev.network.port.description')}: ${info[2]}`
      : `${msg('dev.network.port')}: ${port}\n${msg('dev.network.port.service')}: ${msg('dev.network.port.unknown')}`;
    await emitText(ctx, 'port-reference.txt', text);
    return { extra: { port, service: info?.[0] ?? 'unknown' } };
  },
};

function hostIsValid(host: string): boolean {
  if (isIPv4Address(host) || isIPv6Address(host)) return true;
  if (!host || host.length > 253) return false;
  return host.split('.').every((label) => label.length > 0 && label.length <= 63 && /^[a-z\d_-]+$/i.test(label) && !label.startsWith('-') && !label.endsWith('-'));
}

function isIPv4Address(host: string): boolean {
  const octets = host.split('.');
  return octets.length === 4 && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

const systemNetwork: ToolImpl = {
  id: 'system-network',
  async run(ctx) {
    const msg = makeMsg(localeOf(ctx));
    const [{ networkInterfaces }, { getServers }] = await Promise.all([
      import(/* @vite-ignore */ 'node:os'),
      import(/* @vite-ignore */ 'node:dns/promises'),
    ]);
    const interfaces = networkInterfaces();
    const lines = [`${msg('dev.localNetwork.dns')}: ${getServers().join(', ') || '—'}`];
    for (const name of Object.keys(interfaces).sort()) {
      const addresses = interfaces[name] ?? [];
      if (!addresses.length) continue;
      lines.push('', `${msg('dev.localNetwork.interface')}: ${name}`);
      for (const address of addresses) {
        lines.push(`  ${address.family} ${address.cidr ?? address.address} · ${address.internal ? msg('dev.localNetwork.loopback') : msg('dev.localNetwork.active')} · ${msg('dev.localNetwork.mac')}: ${address.mac || '—'}`);
      }
    }
    await emitText(ctx, 'local-network-info.txt', lines.join('\n'));
    return { extra: { interfaces: Object.keys(interfaces).length } };
  },
};

const pingCheck: ToolImpl = {
  id: 'ping-check',
  async run(ctx) {
    const msg = makeMsg(localeOf(ctx));
    const [{ execFile }, { platform }] = await Promise.all([
      import(/* @vite-ignore */ 'node:child_process'),
      import(/* @vite-ignore */ 'node:os'),
    ]);
    const host = optStr(ctx, 'host');
    if (!hostIsValid(host)) fail(msg, 'dev.error.hostname');
    const count = Math.max(1, Math.min(10, Math.trunc(optNum(ctx, 'count', 4))));
    const args = platform() === 'win32' ? ['-n', String(count), '-w', '2000', host]
      : platform() === 'darwin' ? ['-c', String(count), '-W', '2000', host]
        : ['-c', String(count), '-W', '2', host];
    const result = await new Promise<{ stdout: string; stderr: string; errorCode: number | string | null }>((resolve) => {
      execFile('ping', args, { timeout: count * 2300 + 1500, windowsHide: true, maxBuffer: 128 * 1024 }, (error, stdout, stderr) => {
        const code = error && typeof error.code === 'number' ? error.code : error ? (error as NodeJS.ErrnoException).code ?? 'error' : null;
        resolve({ stdout: String(stdout), stderr: String(stderr), errorCode: code });
      });
    });
    if (result.errorCode === 'ENOENT') fail(msg, 'dev.error.pingUnavailable');
    const reachable = result.errorCode === null;
    const report = [`${msg('dev.localNetwork.target')}: ${host}`, `${msg('dev.localNetwork.status')}: ${msg(reachable ? 'dev.localNetwork.reachable' : 'dev.localNetwork.unreachable')}`, '', (result.stdout || result.stderr).trim() || String(result.errorCode ?? '')].filter(Boolean).join('\n');
    await emitText(ctx, 'ping-result.txt', report);
    return { extra: { reachable: reachable ? 1 : 0, count } };
  },
};

const tcpCheck: ToolImpl = {
  id: 'tcp-check',
  async run(ctx) {
    const msg = makeMsg(localeOf(ctx));
    const { createConnection } = await import(/* @vite-ignore */ 'node:net');
    const host = optStr(ctx, 'host');
    const port = Math.trunc(optNum(ctx, 'port', 0));
    if (!hostIsValid(host)) fail(msg, 'dev.error.hostname');
    if (port < 1 || port > 65535) fail(msg, 'dev.error.port');
    const started = Date.now();
    const result = await new Promise<{ connected: boolean; error: string }>((resolve) => {
      const socket = createConnection({ host, port });
      const timer = setTimeout(() => { socket.destroy(); resolve({ connected: false, error: 'timeout' }); }, 5000);
      socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve({ connected: true, error: '' }); });
      socket.once('error', (error) => { clearTimeout(timer); resolve({ connected: false, error: (error as NodeJS.ErrnoException).code ?? 'error' }); });
    });
    const elapsed = Date.now() - started;
    const status = result.connected ? 'dev.localNetwork.connected' : result.error === 'timeout' ? 'dev.localNetwork.timeout' : 'dev.localNetwork.refused';
    const report = [`${msg('dev.localNetwork.target')}: ${host}:${port}`, `${msg('dev.localNetwork.status')}: ${msg(status)}`, `${msg('dev.localNetwork.elapsed')}: ${elapsed} ms`, ...(result.error && result.error !== 'timeout' ? [`${msg('dev.localNetwork.errorCode')}: ${result.error}`] : [])].join('\n');
    await emitText(ctx, 'tcp-connection-result.txt', report);
    return { extra: { connected: result.connected ? 1 : 0, elapsedMs: elapsed } };
  },
};

const ipLookup: ToolImpl = {
  id: 'ip-lookup',
  async run(ctx) {
    const msg = makeMsg(localeOf(ctx));
    const ip = optStr(ctx, 'ip');
    if (ip && !isIPv4Address(ip) && !isIPv6Address(ip)) fail(msg, 'dev.error.ipLookupAddress');
    let response: Response;
    try {
      const endpoint = `https://ip.bt.cn/ip_api.php${ip ? `?ip=${encodeURIComponent(ip)}` : ''}`;
      response = await fetch(endpoint, { signal: AbortSignal.timeout(8000) });
    } catch {
      fail(msg, 'dev.error.ipLookupNetwork');
    }
    if (!response.ok) fail(msg, 'dev.error.ipLookupNetwork');
    let payload: { code?: number; msg?: string; data?: { ip?: string; info?: Record<string, unknown> } };
    try { payload = await response.json() as typeof payload; } catch { fail(msg, 'dev.error.ipLookupResponse'); }
    const info = payload.data?.info;
    if (payload.code !== 200 || !info || typeof info !== 'object') fail(msg, 'dev.error.ipLookupResponse');
    const value = (key: string) => typeof info[key] === 'string' ? String(info[key]).trim() : '';
    const rows = [
      `${msg('dev.ipLookup.queryType')}: ${ip ? msg('dev.ipLookup.customIP') : msg('dev.ipLookup.localPublicIP')}`,
      `${msg('dev.ipLookup.ip')}: ${payload.data?.ip || ip}`,
      `${msg('dev.ipLookup.continent')}: ${value('continent') || '—'}`,
      `${msg('dev.ipLookup.country')}: ${value('country') || '—'}${value('country_en') ? ` (${value('country_en')})` : ''}`,
      `${msg('dev.ipLookup.countryCode')}: ${value('country_code') || '—'}`,
      `${msg('dev.ipLookup.region')}: ${value('region') || '—'}`,
      `${msg('dev.ipLookup.city')}: ${value('city') || '—'}`,
      `${msg('dev.ipLookup.county')}: ${value('county') || '—'}`,
      `${msg('dev.ipLookup.isp')}: ${value('isp') || '—'}`,
      `${msg('dev.ipLookup.zipcode')}: ${value('zipcode') || '—'}`,
      `${msg('dev.ipLookup.coordinates')}: ${value('lng') && value('lat') ? `${value('lat')}, ${value('lng')}` : '—'}`,
      `${msg('dev.ipLookup.source')}: ip.bt.cn`,
    ];
    await emitText(ctx, 'ip-lookup.txt', rows.join('\n'));
    return { extra: { ip: payload.data?.ip || ip, queryType: ip ? 'custom' : 'local-public', country: value('country'), city: value('city'), isp: value('isp') } };
  },
};

export const developerTools: ToolImpl[] = [fileBase64, base64File, bcryptTool, jsonFormat, xmlFormat, xmlJson, yamlJson, regexTest, binaryCodec, caseConvert, userAgent, ipv4Convert, ipv4Subnet, colorConvert, robotsTxt, spfRecord, dmarcRecord, dnsLookup, urlInspect, ipv6Convert, portReference, systemNetwork, pingCheck, tcpCheck, ipLookup];

const EMBEDDED_DEVELOPER_IDS = new Set([
  'base64-file', 'bcrypt', 'json-format', 'xml-format', 'xml-json', 'yaml-json', 'binary-codec', 'case-convert',
  'user-agent', 'ipv4-convert', 'ipv4-subnet', 'color-convert', 'robots-txt', 'spf-record', 'ip-lookup',
  'dmarc-record', 'url-inspect', 'ipv6-convert', 'port-reference',
]);

export const embeddedDeveloperTools = developerTools.filter((tool) => EMBEDDED_DEVELOPER_IDS.has(tool.id));
export const embeddedNetworkTools: ToolImpl[] = [embeddedDnsLookup, embeddedSystemNetwork, embeddedPingCheck, embeddedTcpCheck];
export const embeddedDeveloperFileTools = developerTools.filter((tool) => tool.id === 'file-base64');
