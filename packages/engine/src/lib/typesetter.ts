import { StandardFonts, rgb, type PDFFont, type PDFDocument, type PDFPage } from 'pdf-lib';
import type { FlowBlock } from './docmodel.ts';
import { textFont } from './fonts.ts';
import type { Box } from './pdf.ts';
import { parseInline } from './textfmt.ts';

export interface TypesetStyle {
  size: number;
  lineHeight: number;
  paragraphGap: number;
  headingGap: number;
  indent: number;
}

const DEFAULT_STYLE: TypesetStyle = {
  size: 11,
  lineHeight: 1.45,
  paragraphGap: 7,
  headingGap: 11,
  indent: 16,
};

export interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

export interface TypesetImage {
  bytes: Uint8Array;
  /** Optional natural size in points; measured from the image when omitted. */
  width?: number;
  height?: number;
}

const CJK = /[\u3000-\u30ff\u4e00-\u9fff\uac00-\ud7af\uff00-\uff60]/;

/** True when pdf-lib's standard 14 fonts can encode the string. */
export function latinOnly(text: string): boolean {
  return !CJK.test(text) && /^[\x20-\x7e\xa0-\xff]*$/.test(text);
}

/** Wraps a string to a width in points, breaking CJK per character. */
export function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const laid = layoutRuns([{ text }], () => font, size, maxWidth);
  const lines = laid.map((line) => line.map((run) => run.text).join('').trimEnd());
  return lines.length ? lines : [''];
}

interface LayoutRun extends Run {
  width: number;
}

/**
 * Breaks styled runs into lines. Latin text wraps at spaces, CJK anywhere, and
 * each piece keeps the font it must be drawn with.
 */
function layoutRuns(
  runs: Run[],
  fontOf: (run: Run) => PDFFont,
  size: number,
  maxWidth: number,
): LayoutRun[][] {
  const lines: LayoutRun[][] = [[]];
  let width = 0;
  const newline = (): void => {
    if (lines[lines.length - 1]!.length) lines.push([]);
    width = 0;
  };
  for (const run of runs) {
    if (!run.text) continue;
    const font = fontOf(run);
    const units = CJK.test(run.text) ? Array.from(run.text) : run.text.split(/(?<=\s)/);
    for (const unit of units) {
      const piece = font.widthOfTextAtSize(unit, size);
      if (width + piece > maxWidth) newline();
      const last = lines[lines.length - 1]!;
      const tail = last[last.length - 1];
      if (tail && tail.bold === run.bold && tail.italic === run.italic && tail.code === run.code) {
        tail.text += unit;
        tail.width += piece;
      } else {
        last.push({ ...run, text: unit, width: piece });
      }
      width += piece;
    }
  }
  return lines.filter((line) => line.length > 0);
}

/** Draws the shared flow model onto PDF pages. */
export class Typesetter {
  private page: PDFPage;

  private y: number;

  private readonly fonts = new Map<string, PDFFont>();

  private cjk: PDFFont | null = null;

  constructor(
    private readonly doc: PDFDocument,
    private readonly box: Box,
    private readonly margin: number,
    private readonly style: TypesetStyle = DEFAULT_STYLE,
    private readonly fontPath: string | null = null,
  ) {
    this.page = doc.addPage([box.width, box.height]);
    this.y = box.height - margin;
  }

  get pageCount(): number {
    return this.doc.getPageCount();
  }

  get contentWidth(): number {
    return Math.max(40, this.box.width - this.margin * 2);
  }

  get cursorY(): number {
    return this.y;
  }

  private async fontFor(text: string, bold: boolean, italic = false, code = false): Promise<PDFFont> {
    if (code && /^[\x20-\x7e]*$/.test(text)) {
      const key = 'courier';
      const cached = this.fonts.get(key);
      if (cached) return cached;
      const font = await this.doc.embedFont(StandardFonts.Courier);
      this.fonts.set(key, font);
      return font;
    }
    if (/^[\x20-\x7e\xa0-\xff]*$/.test(text)) {
      const variant = bold && italic
        ? StandardFonts.HelveticaBoldOblique
        : bold
          ? StandardFonts.HelveticaBold
          : italic
            ? StandardFonts.HelveticaOblique
            : StandardFonts.Helvetica;
      const cached = this.fonts.get(variant);
      if (cached) return cached;
      const font = await this.doc.embedFont(variant);
      this.fonts.set(variant, font);
      return font;
    }
    if (!this.cjk) {
      const { font } = await textFont(this.doc, text, { fontPath: this.fontPath });
      this.cjk = font;
    }
    return this.cjk;
  }

  newPage(): void {
    this.doc.addPage([this.box.width, this.box.height]);
    const pages = this.doc.getPages();
    this.page = pages[pages.length - 1]!;
    this.y = this.box.height - this.margin;
  }

  ensure(space: number): void {
    if (this.y - space < this.margin) this.newPage();
  }

  /** Lays out styled runs at the current cursor and advances it. */
  async runs(runs: Run[], size: number, indent = 0): Promise<void> {
    const keyOf = (run: Run): string =>
      `${run.bold ? 'b' : ''}${run.italic ? 'i' : ''}${run.code ? 'c' : ''}:${latinOnly(run.text) ? 'latin' : 'unicode'}`;
    const cache = new Map<string, PDFFont>();
    for (const run of runs) {
      const key = keyOf(run);
      if (!cache.has(key)) {
        cache.set(key, await this.fontFor(run.text || 'a', Boolean(run.bold), Boolean(run.italic), Boolean(run.code)));
      }
    }
    const fontOf = (run: Run): PDFFont => cache.get(keyOf(run))!;
    const laid = layoutRuns(runs, fontOf, size, this.contentWidth - indent);
    for (const line of laid) {
      this.ensure(size * this.style.lineHeight);
      this.y -= size * this.style.lineHeight;
      let x = this.margin + indent;
      for (const run of line) {
        const font = fontOf(run);
        const drawn = run.text.replace(/\s+$/, '');
        if (drawn) {
          this.page.drawText(drawn, {
            x,
            y: this.y,
            size,
            font,
            color: run.code ? rgb(0.45, 0.16, 0.2) : rgb(0.08, 0.1, 0.14),
          });
        }
        x += font.widthOfTextAtSize(run.text, size);
      }
    }
  }

  async image(block: Extract<FlowBlock, { kind: 'image' }>, image: TypesetImage | null): Promise<void> {
    if (!image) return;
    try {
      const embedded =
        image.bytes[0] === 0xff && image.bytes[1] === 0xd8
          ? await this.doc.embedJpg(image.bytes)
          : await this.doc.embedPng(image.bytes);
      const natural = { width: image.width || embedded.width, height: image.height || embedded.height };
      const scale = Math.min(1, this.contentWidth / natural.width, (this.box.height * 0.55) / natural.height);
      const width = Math.max(24, natural.width * scale);
      const height = Math.max(24, natural.height * scale);
      this.ensure(height + 10);
      this.y -= height;
      this.page.drawImage(embedded, { x: this.margin, y: this.y, width, height });
      this.y -= 10;
    } catch {
      await this.runs([{ text: `[图片 ${block.page || ''}]` }], this.style.size);
    }
  }

  async block(
    flow: FlowBlock[],
    options: {
      imageFor?: (block: Extract<FlowBlock, { kind: 'image' }>, index: number) => TypesetImage | null;
      inline?: boolean;
    } = {},
  ): Promise<void> {
    let imageIndex = 0;
    for (const block of flow) {
      switch (block.kind) {
        case 'heading': {
          const size = Math.max(this.style.size, this.style.size * (1.75 - Math.min(6, block.level) * 0.13));
          this.y -= this.style.headingGap;
          await this.runs([{ text: block.text, bold: true }], size);
          break;
        }
        case 'paragraph': {
          const runs = options.inline ? parseInline(block.text) : [{ text: block.text, bold: block.bold }];
          await this.runs(runs, this.style.size);
          this.y -= this.style.paragraphGap;
          break;
        }
        case 'list': {
          for (const [index, item] of block.items.entries()) {
            const marker = block.ordered ? `${index + 1}.` : '•';
            const parts = options.inline ? parseInline(item) : [{ text: item }];
            await this.runs([{ text: `${marker}  ` }, ...parts], this.style.size, this.style.indent);
          }
          this.y -= this.style.paragraphGap;
          break;
        }
        case 'image': {
          imageIndex += 1;
          await this.image(block, options.imageFor?.(block, imageIndex) ?? null);
          break;
        }
        case 'pageBreak':
          this.newPage();
          break;
        default:
          break;
      }
    }
  }
}
