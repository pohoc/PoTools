import { inflateSync } from 'node:zlib';
import {
  PDFArray,
  PDFContentStream,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  type PDFDocument,
} from 'pdf-lib';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Reads the `cm ... /Im Do` pairs of a page to find where each image is drawn.
 * MuPDF's structured text drops image blocks in this WASM build, so placement
 * has to come from the content stream; exporters then crop those regions out of
 * the rendered page instead of decoding the image streams.
 */
export function pageImageRects(doc: PDFDocument, pageIndex: number): Rect[] {
  const page = doc.getPage(pageIndex);
  const names = imageResourceNames(doc, page.node.Resources() ?? inheritedResources(doc, pageIndex));
  if (!names.size) return [];
  const content = contentText(doc, page.node.Contents());
  if (!content) return [];

  const placed: Rect[] = [];
  const stack: number[][] = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const operandRun: (string | number)[] = [];

  for (const token of tokenize(content)) {
    const numeric = Number(token);
    if (Number.isFinite(numeric) && token.trim() !== '') {
      operandRun.push(numeric);
      continue;
    }
    switch (token) {
      case 'q':
        stack.push(ctm);
        break;
      case 'Q':
        ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
        break;
      case 'cm': {
        if (operandRun.length >= 6) ctm = multiply(operandRun.slice(-6) as number[], ctm);
        break;
      }
      case 'Do': {
        const name = operandRun[operandRun.length - 1];
        if (typeof name === 'string' && names.has(name)) placed.push(rectFromCtm(ctm));
        break;
      }
      default:
        break;
    }
    operandRun.length = 0;
  }

  return placed
    .map((rect) => ({
      x: Math.min(rect.x, rect.x + rect.w),
      y: Math.min(rect.y, rect.y + rect.h),
      w: Math.abs(rect.w),
      h: Math.abs(rect.h),
    }))
    .filter((rect) => rect.w >= 18 && rect.h >= 18);
}

function inheritedResources(doc: PDFDocument, pageIndex: number): PDFDict | undefined {
  let node = doc.getPage(pageIndex).node.Parent();
  while (node) {
    const resources = node.get(PDFName.of('Resources'));
    if (resources instanceof PDFDict) return resources;
    node = node.Parent();
  }
  return undefined;
}

function imageResourceNames(doc: PDFDocument, resources: PDFDict | undefined): Set<string> {
  const found = new Set<string>();
  if (!(resources instanceof PDFDict)) return found;
  const raw = resources.get(PDFName.of('XObject'));
  const dict = raw instanceof PDFRef ? doc.context.lookup(raw) : raw;
  if (!(dict instanceof PDFDict)) return found;
  for (const [name, value] of dict.entries()) {
    const target = value instanceof PDFRef ? doc.context.lookup(value) : value;
    if (!(target instanceof PDFRawStream)) continue;
    if (target.dict.get(PDFName.of('Subtype'))?.toString() !== '/Image') continue;
    if (target.dict.get(PDFName.of('ImageMask'))?.toString() === 'true') continue;
    found.add(name.toString().slice(1));
  }
  return found;
}

function contentText(doc: PDFDocument, contents: unknown): string {
  const parts: Uint8Array[] = [];
  const collect = (value: unknown): void => {
    const resolved = value instanceof PDFRef ? doc.context.lookup(value) : value;
    if (resolved instanceof PDFArray) {
      for (let index = 0; index < resolved.size(); index += 1) collect(resolved.get(index));
      return;
    }
    if (resolved instanceof PDFContentStream) {
      parts.push(Buffer.from(resolved.getContentsString(), 'utf8'));
      return;
    }
    if (resolved instanceof PDFRawStream) {
      const filter = resolved.dict.get(PDFName.of('Filter'))?.toString() ?? '';
      const bytes = resolved.contents;
      if (!bytes) return;
      try {
        parts.push(filter.includes('FlateDecode') ? new Uint8Array(inflateSync(Buffer.from(bytes))) : bytes);
      } catch {
        parts.push(bytes);
      }
    }
  };
  collect(contents);
  return parts.map((part) => Buffer.from(part).toString('latin1')).join('\n');
}

/** Numbers, `/Names` and operators; literal strings and comments are skipped. */
function tokenize(content: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < content.length) {
    const char = content[index]!;
    if (char === '%') {
      while (index < content.length && content[index] !== '\n') index += 1;
      continue;
    }
    if (char === '(') {
      let depth = 1;
      index += 1;
      while (index < content.length && depth > 0) {
        const current = content[index]!;
        if (current === '\\') index += 1;
        else if (current === '(') depth += 1;
        else if (current === ')') depth -= 1;
        index += 1;
      }
      tokens.push('str');
      continue;
    }
    if (char === '<' || char === '[' || char === ']' || char === '>' || (char === '<' && content[index + 1] === '<')) {
      index += 1;
      continue;
    }
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < content.length && !/[\s<>[\]()/]/.test(content[end]!)) end += 1;
    if (end === index) end += 1;
    tokens.push(content.slice(index, end));
    index = end;
  }
  return tokens;
}

function multiply(a: number[], b: number[]): number[] {
  return [
    a[0]! * b[0]! + a[2]! * b[1]!,
    a[1]! * b[0]! + a[3]! * b[1]!,
    a[0]! * b[2]! + a[2]! * b[3]!,
    a[1]! * b[2]! + a[3]! * b[3]!,
    a[0]! * b[4]! + a[2]! * b[5]! + a[4]!,
    a[1]! * b[4]! + a[3]! * b[5]! + a[5]!,
  ];
}

/** The unit square of an image XObject mapped through the current matrix. */
function rectFromCtm(m: number[]): Rect {
  const corners = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ] as const;
  const points = corners.map(
    (corner) => [m[0]! * corner[0] + m[2]! * corner[1] + m[4]!, m[1]! * corner[0] + m[3]! * corner[1] + m[5]!] as const,
  );
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
}

/**
 * Folds a user-space rectangle into the visual (top-left origin) space that
 * MuPDF renders and structured text reports in.
 */
export function toVisualRect(rect: Rect, width: number, height: number, rotation: number): Rect {
  switch (((Math.round(rotation) % 360) + 360) % 360) {
    case 90:
      return { x: rect.y, y: width - (rect.x + rect.w), w: rect.h, h: rect.w };
    case 180:
      return { x: width - (rect.x + rect.w), y: height - (rect.y + rect.h), w: rect.w, h: rect.h };
    case 270:
      return { x: height - (rect.y + rect.h), y: rect.x, w: rect.h, h: rect.w };
    default:
      return { x: rect.x, y: height - (rect.y + rect.h), w: rect.w, h: rect.h };
  }
}

export function pageBoxOf(doc: PDFDocument, pageIndex: number): { width: number; height: number } {
  const page = doc.getPage(pageIndex);
  const box = page.node.MediaBox();
  const read = (index: number): number => {
    const value = box.get(index);
    return value instanceof PDFNumber ? value.asNumber() : 0;
  };
  return { width: read(2) - read(0), height: read(3) - read(1) };
}
