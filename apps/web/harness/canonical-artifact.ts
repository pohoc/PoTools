/**
 * Stable artifact digests for the golden test oracle (worker-only migration
 * phase 0). Raw bytes of pdf-lib PDFs and ZIP containers differ between runs
 * (embedded timestamps — including inside FlateDecode object streams), so both
 * capture sides hash a canonical form: PDFs with date fields blanked in the
 * skeleton and in inflated streams, ZIPs as sorted date-normalized entry
 * pairs, and everything else raw. Must stay importable from Node and the
 * browser, so it only uses Web APIs.
 */
import JSZip from 'jszip';

/** Bump when canonicalization changes; golden files record the version they were captured with. */
export const CANONICAL_VERSION = 5;

const ENCODER = new TextEncoder();
const ISO_DATE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/g;

/** Blanks PDF/Office-style timestamps so identity reflects content only. */
export function stripTimestamps(text: string): string {
  return text
    .replace(/\(D:\d{4}[0-9+Z\-']*\)/g, '(D:19700101000000Z)')
    .replace(/(<xmp:(?:CreateDate|ModifyDate|MetadataDate)>)[^<]*(<\/xmp:)/g, '$11970-01-01T00:00:00Z$2')
    .replace(ISO_DATE, '1970-01-01T00:00:00Z')
    // OFD 文档号（毫秒十六进制）与 EPUB 时间戳 uid 每次运行都会变化。
    .replace(/<(?:[A-Za-z0-9-]+:)?DocID>[0-9a-fA-F]*<\/(?:[A-Za-z0-9-]+:)?DocID>/g, '<ofd:DocID>N</ofd:DocID>')
    .replace(/urn:uuid:[0-9a-z]+/gi, 'urn:uuid:N');
}

function latin1(bytes: Uint8Array): string {
  let out = '';
  const step = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += step) {
    out += String.fromCharCode(...bytes.subarray(offset, offset + step));
  }
  return out;
}

/** Inverse of latin1(): maps each char code back to one byte (mod 256). */
function fromLatin1(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index) & 0xff;
  return bytes;
}

async function sha256Text(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', ENCODER.encode(text) as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function inflateZlib(data: Uint8Array): Promise<Uint8Array | null> {
  try {
    const stream = new Blob([data as unknown as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Rewrites every FlateDecode stream as the digest of its date-normalized
 * decompressed text; timestamps live inside compressed object streams, so
 * whole-file regexes alone never reach them. Non-inflatable streams stay
 * byte-identical, which is deterministic for a fixed producer.
 */
export async function canonicalPdfText(bytes: Uint8Array): Promise<string> {
  const text = latin1(bytes);
  let out = '';
  let cursor = 0;
  const keyword = /stream\r?\n/g;
  keyword.lastIndex = 0;
  for (let match = keyword.exec(text); match; match = keyword.exec(text)) {
    // `endstream` contains the keyword; when a previous stream ended exactly
    // at its boundary the regex re-hits that tail — skip the false match.
    if (match.index >= 3 && text.slice(match.index - 3, match.index) === 'end') {
      keyword.lastIndex = match.index + match[0].length;
      continue;
    }
    const streamStart = match.index + match[0].length;
    if (streamStart >= text.length) break;
    // Scope the dict window to the current object so a previous object's
    // /Length never leaks into this stream's bounds.
    const objStart = text.lastIndexOf(' obj', match.index);
    const dict = text.slice(objStart < 0 ? Math.max(0, match.index - 1024) : objStart, match.index);
    const lengthMatch = /\/Length\s+(\d+)(?!\s*\d)(?!\s+\d+\s+R)/.exec(dict);
    const declared = lengthMatch ? streamStart + Number(lengthMatch[1]) : -1;
    let content: string;
    let nextIndex: number;
    if (declared >= streamStart && declared <= text.length) {
      // Exact /Length bytes: any EOL before `endstream` lies outside the stream.
      content = text.slice(streamStart, declared);
      nextIndex = declared;
    } else {
      const contentEnd = text.indexOf('endstream', streamStart);
      if (contentEnd < 0) break;
      content = text.slice(streamStart, contentEnd);
      if (content.endsWith('\r')) content = content.slice(0, -1);
      else if (content.endsWith('\n')) content = content.slice(0, -1);
      nextIndex = contentEnd;
    }
    let skeleton = text.slice(cursor, streamStart);
    if (/\/FlateDecode/.test(dict)) {
      // Compressed length depends on deflate entropy (e.g. timestamp bytes
      // inside the stream), not on document content — normalize it.
      skeleton = skeleton.replace(/\/Length\s+\d+(?![\s\S]*\/Length)/, (match) => match.replace(/\d+/, 'N'));
    }
    out += skeleton;
    if (/\/FlateDecode/.test(dict)) {
      if (/\/Type\s*\/XRef/.test(dict)) {
        // Cross-reference streams are pure offset bookkeeping; their packed
        // offsets shift with any benign length change elsewhere.
        out += '«xref»';
      } else {
        const inflated = await inflateZlib(fromLatin1(content));
        out += inflated
          ? `«flatedigest:${await sha256Text(stripTimestamps(latin1(inflated)))}»`
          : content;
      }
    } else {
      out += content;
    }
    cursor = nextIndex;
    keyword.lastIndex = nextIndex;
  }
  out += text.slice(cursor);
  return stripTimestamps(out).replace(/startxref\r?\n\d+/g, 'startxref\nN');
}

interface ZipEntryFingerprint {
  name: string;
  contentSha256: string;
  uncompressedSize: number;
}

/** Reads every entry uncompressed; producer-specific deflate output is ignored. */
export async function zipEntryFingerprints(bytes: Uint8Array): Promise<ZipEntryFingerprint[]> {
  const zip = await JSZip.loadAsync(bytes);
  const entries: ZipEntryFingerprint[] = [];
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const content = await entry.async('uint8array');
    entries.push({
      name,
      contentSha256: await sha256Text(stripTimestamps(latin1(content))),
      uncompressedSize: content.byteLength,
    });
  }
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return entries;
}

/**
 * Digest that is stable across runs and across the Node/browser producers:
 * PDFs compare modulo timestamps (including compressed streams), ZIP
 * containers compare by entry names and date-normalized uncompressed
 * contents, text artifacts compare with extractor-specific blank-run counts
 * collapsed (MuPDF and PDF.js pad pages differently), everything else
 * compares raw bytes.
 */
export async function canonicalArtifactDigest(bytes: Uint8Array, kind?: string): Promise<string> {
  if (bytes.length >= 5 && latin1(bytes.subarray(0, 5)) === '%PDF-') {
    return sha256Text(`pdf:${await canonicalPdfText(bytes)}`);
  }
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return sha256Text(`zip:${JSON.stringify(await zipEntryFingerprints(bytes))}`);
  }
  if (kind === 'text' || kind === 'json') {
    return sha256Text(`text:${stripTimestamps(latin1(bytes)).replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '')}`);
  }
  return sha256Bytes(bytes);
}
