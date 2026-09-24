import type { RpcMethodName, ToolId } from '@potools/core';
import { embeddedFileToolImplementations, embeddedTextToolImplementations } from './embedded-registry.ts';
import { canParseEmbeddedX509 } from './tools/crypto-x509-browser.ts';

export interface EmbeddedRpcDescriptor {
  method: RpcMethodName;
  params: Record<string, unknown>;
}

type TextToolCapability = (options: Record<string, unknown>) => boolean;

export function canRunEmbeddedFileJob(tool: ToolId, options: Record<string, unknown> = {}): boolean {
  if (!embeddedFileToolImplementations[tool]) return false;
  if (tool === 'pdf-to-epub' && (options.includeImages === true || options.includeImages === 'true' || options.includeImages === 1 || options.includeImages === '1')) {
    return typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function';
  }
  if (tool === 'pdf-to-word' && (options.includeImages === true || options.includeImages === 'true' || options.includeImages === 1 || options.includeImages === '1')) {
    return typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function';
  }
  if (tool === 'pdf-to-images') return typeof OffscreenCanvas !== 'undefined' && typeof Worker !== 'undefined';
  if (tool === 'images-to-pdf') return typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function';
  if (tool === 'crop' && (options.shrinkToContent === true || options.shrinkToContent === 'true' || options.shrinkToContent === 1 || options.shrinkToContent === '1')) {
    return typeof Worker !== 'undefined';
  }
  if (tool === 'compress' && options.resampleImages !== false && options.resampleImages !== 'false' && options.resampleImages !== 0 && options.resampleImages !== '0') {
    return typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function';
  }
  if (tool === 'remove-blank') return typeof Worker !== 'undefined';
  if (tool === 'repair') return typeof Worker !== 'undefined';
  if (tool === 'invoice-merge') {
    const autoCrop = options.autoCrop !== false && options.autoCrop !== 'false' && options.autoCrop !== 0 && options.autoCrop !== '0';
    return !autoCrop || typeof Worker !== 'undefined';
  }
  if (tool === 'extract-images' && String(options.format ?? 'original') !== 'original') {
    return typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function';
  }
  if (tool === 'file-checksum') {
    const algorithm = String(options.algorithm ?? '').toLowerCase();
    return ['md5', 'sha1', 'sha256', 'sha512', 'all'].includes(algorithm) && (Boolean(globalThis.crypto?.subtle) || algorithm === 'md5');
  }
  if (tool === 'image-watermark-clean' && typeof options.repairPng !== 'string') return false;
  return true;
}

/**
 * The single routing policy for RPC methods that may be handled in the
 * embedded Worker. A true result means "try the dispatcher"; the dispatcher
 * remains authoritative and can return handled:false for unsupported inputs.
 */
export function canRunEmbeddedRpc({ method, params }: EmbeddedRpcDescriptor): boolean {
  switch (method) {
    case 'tool.run': {
      const tool = params.tool as ToolId;
      const options = (params.options ?? {}) as Record<string, unknown>;
      return Boolean(embeddedTextToolImplementations[tool])
        && (TEXT_TOOL_CAPABILITIES[tool] ?? ALWAYS_EMBEDDED)(options);
    }
    case 'job.submit': {
      const job = params.job as { tool?: ToolId; options?: Record<string, unknown>; globals?: Record<string, unknown> } | undefined;
      if (!job?.tool) return false;
      if (job.tool === 'pdf-to-ofd') {
        const mode = String(job.options?.mode ?? 'text');
        return mode === 'image' || mode === 'text';
      }
      return canRunEmbeddedFileJob(job.tool, job.options);
    }
    case 'invoice.scan':
      return Boolean(params.file && typeof params.file === 'object') && Boolean(globalThis.crypto?.subtle);
    case 'file.probe':
    case 'page.list':
    case 'page.thumbs':
      return true;
    default:
      return false;
  }
}

const ALWAYS_EMBEDDED: TextToolCapability = () => true;

/**
 * Per-tool constraints live behind the shared RPC route. Adding an embedded
 * implementation should register its execution boundary here instead of
 * changing callers or adding another transport entry point.
 */
const TEXT_TOOL_CAPABILITIES: Partial<Record<ToolId, TextToolCapability>> = {
  rsa: rsaCanRunEmbedded,
  x509: x509CanRunEmbedded,
  'regex-test': () => typeof Worker !== 'undefined',
  jwt: jwtCanRunEmbedded,
  aes: embeddedAesPayloadIsSupported,
  hash: (options) => {
    const algorithm = String(options.algorithm ?? '').toLowerCase();
    return ['md5', 'sha1', 'sha256', 'sha384', 'sha512', 'blake2b512'].includes(algorithm)
      && (Boolean(globalThis.crypto?.subtle) || algorithm === 'md5' || algorithm === 'blake2b512');
  },
  hmac: (options) => {
    const algorithm = String(options.algorithm ?? 'sha256').toLowerCase();
    return ['md5', 'sha1', 'sha256', 'sha512'].includes(algorithm)
      && (Boolean(globalThis.crypto?.subtle) || algorithm === 'md5');
  },
};

function x509CanRunEmbedded(options: Record<string, unknown>): boolean {
  if (!globalThis.crypto?.subtle) return false;
  const input = String(options.pem ?? '');
  const block = input.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/)?.[0];
  if (!block) return false;
  return canParseEmbeddedX509(block);
}

function rsaCanRunEmbedded(options: Record<string, unknown>): boolean {
  if (!globalThis.crypto?.subtle) return false;
  const mode = String(options.mode ?? 'generate');
  const inputIsUsable = (value: unknown, requiresPrivate: boolean): boolean => {
    const text = String(value ?? '').trim();
    if (!text) return false;
    if (/ENCRYPTED PRIVATE KEY|Proc-Type:\s*4,ENCRYPTED/i.test(text) && !String(options.passphrase ?? '')) return false;
    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text) as Record<string, unknown> | unknown[];
        const values = Array.isArray(parsed) ? parsed : [((parsed as Record<string, unknown>).keys ?? parsed)];
        return values.some((item) => item && typeof item === 'object'
          && String((item as Record<string, unknown>).kty).toUpperCase() === 'RSA'
          && (!requiresPrivate || typeof (item as Record<string, unknown>).d === 'string'));
      } catch { return false; }
    }
    if (/-----BEGIN (?:PRIVATE KEY|RSA PRIVATE KEY)-----/.test(text)) return true;
    if (!requiresPrivate && /-----BEGIN (?:PUBLIC KEY|RSA PUBLIC KEY)-----/.test(text)) return true;
    const compact = text.replace(/\s/g, '');
    return compact.length > 32 && /^[A-Za-z0-9+/_=-]+$/.test(compact);
  };
  if (mode === 'generate') return true;
  if (mode === 'encrypt') return inputIsUsable(options.publicKey, false);
  if (mode === 'decrypt') return inputIsUsable(options.privateKey, true);
  if (mode === 'sign' || mode === 'pubkey') return inputIsUsable(options.privateKey, true);
  if (mode === 'verify') return inputIsUsable(options.publicKey, false);
  return false;
}

function jwtCanRunEmbedded(options: Record<string, unknown>): boolean {
  const verify = options.verify === true || options.verify === 'true' || options.verify === 1 || options.verify === '1';
  if (!verify) return true;
  if (!globalThis.crypto?.subtle) return false;
  let headerAlgorithm = '';
  const tokenParts = String(options.token ?? '').replace(/\s/g, '').split('.');
  try {
    const source = tokenParts[0] ?? '';
    const binary = atob(source.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(source.length / 4) * 4, '='));
    headerAlgorithm = String((JSON.parse(binary) as Record<string, unknown>).alg ?? '').toLowerCase();
  } catch { /* malformed tokens are reported by the shared JWT runner */ }
  const selected = String(options.algorithm ?? 'auto').toLowerCase();
  const algorithm = selected === 'auto' ? headerAlgorithm : selected;
  if (['hs256', 'hs384', 'hs512'].includes(algorithm)) return true;
  if (!['rs256', 'es256'].includes(algorithm)) return true;
  const secret = String(options.secret ?? '').trim();
  if (secret.includes('-----BEGIN')) return secret.includes('-----BEGIN PUBLIC KEY-----');
  if (!secret.startsWith('{') && !secret.startsWith('[')) return false;
  try {
    const parsed = JSON.parse(secret) as unknown;
    const candidates = Array.isArray(parsed) ? parsed : [(parsed as Record<string, unknown>)?.keys ?? parsed];
    const expected = algorithm === 'rs256' ? 'RSA' : 'EC';
    return candidates.some((item) => {
      if (!item || typeof item !== 'object') return false;
      const key = item as Record<string, unknown>;
      return String(key.kty ?? '').toUpperCase() === expected && (expected !== 'EC' || key.crv === 'P-256');
    });
  } catch { return false; }
}

function embeddedAesPayloadIsSupported(options: Record<string, unknown>): boolean {
  if (String(options.mode ?? 'encrypt') === 'encrypt') return ['scrypt', 'pbkdf2'].includes(String(options.kdf ?? 'scrypt'));
  const raw = String(options.input ?? '').replace(/\s/g, '');
  try {
    let bytes: Uint8Array;
    if (String(options.format ?? 'base64') === 'hex') {
      if (!/^(?:[\da-f]{2})+$/i.test(raw)) return false;
      bytes = Uint8Array.from(raw.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
    } else {
      const normalized = raw.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(raw.length / 4) * 4, '=');
      bytes = Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0));
    }
    return bytes.length > 2 && bytes[0] === 1 && (bytes[1] === 1 || bytes[1] === 2);
  } catch { return false; }
}
