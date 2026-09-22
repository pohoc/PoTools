import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { Document, HeadingLevel, ImageRun, Packer, PageBreak, Paragraph, TextRun } from 'docx';
import type { FlowBlock } from './docmodel.ts';
import { EngineError } from '../errors.ts';

const PT_TO_PX = 96 / 72;

export interface PlacedRegion {
  bytes: Uint8Array;
  /** Size in points as drawn on the source page. */
  width: number;
  height: number;
}

export interface DocxInput {
  title: string;
  blocks: FlowBlock[];
  imageFor: (block: Extract<FlowBlock, { kind: 'image' }>, index: number) => PlacedRegion | null;
  pageBreaks: boolean;
  /** Usable text width in points (page width minus margins). */
  contentWidth: number;
}

/** Builds a .docx from the shared flow model. */
export async function writeDocx(input: DocxInput): Promise<Uint8Array> {
  const children: Paragraph[] = [];
  let imageIndex = 0;

  for (const block of input.blocks) {
    switch (block.kind) {
      case 'heading': {
        const levels = [HeadingLevel.TITLE, HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4];
        children.push(
          new Paragraph({
            heading: levels[Math.min(block.level, levels.length) - 1] ?? HeadingLevel.HEADING_4,
            children: [new TextRun({ text: block.text })],
          }),
        );
        break;
      }
      case 'paragraph':
        children.push(
          new Paragraph({
            children: [new TextRun({ text: block.text, bold: block.bold || undefined })],
          }),
        );
        break;
      case 'list':
        for (const item of block.items) {
          children.push(
            new Paragraph({
              children: [new TextRun({ text: item })],
              bullet: block.ordered ? undefined : { level: 0 },
            }),
          );
        }
        break;
      case 'image': {
        imageIndex += 1;
        const region = input.imageFor(block, imageIndex);
        if (!region) break;
        const maxWidth = Math.max(72, input.contentWidth);
        const scale = Math.min(1, maxWidth / region.width);
        children.push(
          new Paragraph({
            children: [
              new ImageRun({
                type: 'png',
                data: region.bytes,
                transformation: {
                  width: Math.round(region.width * scale * PT_TO_PX),
                  height: Math.round(region.height * scale * PT_TO_PX),
                },
              }),
            ],
          }),
        );
        break;
      }
      case 'pageBreak':
        if (input.pageBreaks) children.push(new Paragraph({ children: [new PageBreak()] }));
        break;
      default:
        break;
    }
  }

  const doc = new Document({
    title: input.title,
    creator: 'PoTools',
    description: 'Converted with PoTools',
    sections: [{ properties: {}, children }],
  });
  return new Uint8Array(await Packer.toBuffer(doc));
}

export interface SheetInput {
  name: string;
  rows: string[][];
}

/** Builds an .xlsx; one sheet per page by default. */
export async function writeXlsx(sheets: SheetInput[]): Promise<Uint8Array> {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'PoTools';
  sheets.forEach((sheet, index) => {
    const ws = workbook.addWorksheet(sheet.name.slice(0, 31) || `Sheet${index + 1}`);
    const widths: number[] = [];
    for (const row of sheet.rows) {
      row.forEach((cell, column) => {
        widths[column] = Math.max(widths[column] ?? 8, Math.min(60, Math.round(cell.length * 1.15) + 2));
      });
      ws.addRow(row);
    }
    widths.forEach((width, column) => {
      ws.getColumn(column + 1).width = width;
    });
    ws.getRow(1).font = { bold: true };
  });
  const buffer = await workbook.xlsx.writeBuffer();
  return buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer as Uint8Array);
}

export interface PptxInput {
  /** One entry per slide, sized in inches. */
  slides: Array<{
    widthIn: number;
    heightIn: number;
    image: Uint8Array;
    lines: Array<{ text: string; xIn: number; yIn: number; wIn: number; hIn: number; size: number; bold: boolean; color?: string }>;
  }>;
  title: string;
}

export async function writePptx(input: PptxInput): Promise<Uint8Array> {
  const mod = await import('pptxgenjs');
  const PptxGenJS = mod.default ?? (mod as unknown as { PptxGenJS: new () => any });
  const pptx: any = typeof PptxGenJS === 'function' ? new PptxGenJS() : (PptxGenJS as any);
  pptx.title = input.title;
  pptx.author = 'PoTools';
  const first = input.slides[0];
  if (first) pptx.defineLayout({ name: 'PDFPAGE', width: first.widthIn, height: first.heightIn });
  pptx.layout = 'PDFPAGE';

  for (const slide of input.slides) {
    const target = pptx.addSlide();
    target.addImage({
      data: `image/png;base64,${Buffer.from(slide.image).toString('base64')}`,
      x: 0,
      y: 0,
      w: slide.widthIn,
      h: slide.heightIn,
    });
    for (const line of slide.lines) {
      target.addText(
        [{ text: line.text, options: { bold: line.bold, fontSize: Math.max(5, Math.round(line.size * 0.72)) } }],
        {
          x: line.xIn,
          y: line.yIn,
          w: line.wIn,
          h: line.hIn,
          color: line.color ?? '000000',
          // Keep generated text as real, visible slide content so Office
          // conversions preserve searchable text instead of flattening it
          // into an invisible annotation.
          transparency: 0,
          valign: 'top',
          fit: 'shrink',
        },
      );
    }
  }
  const written = await pptx.write({ outputType: 'arraybuffer' });
  return new Uint8Array(written as ArrayBuffer);
}

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseAttributeValue: false,
  trimValues: true,
});

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Office files are zip packages; the legacy binary formats are not. */
async function unzip(bytes: Uint8Array, label = 'Office 文档'): Promise<JSZip> {
  try {
    return await JSZip.loadAsync(bytes);
  } catch {
    throw new EngineError(
      'unreadable_file',
      `${label} 不是有效的 Office 2007+ 包，.doc/.xls/.ppt 老格式请先另存为 docx/xlsx/pptx`,
      'error.notOfficePackage',
    );
  }
}

async function readEntry(zip: JSZip, path: string): Promise<string | null> {
  const file = zip.file(path);
  return file ? file.async('string') : null;
}

export interface ReadDocxResult {
  blocks: FlowBlock[];
  images: Map<string, Uint8Array>;
}

/**
 * Reads the paragraph list of a .docx. Layout is re-flowed by the caller, so
 * tables and text boxes are flattened into paragraphs.
 */
export async function readDocx(bytes: Uint8Array): Promise<ReadDocxResult> {
  const zip = await unzip(bytes, 'Word 文档');
  const document = await readEntry(zip, 'word/document.xml');
  if (!document) throw new Error('word/document.xml missing');
  const images = new Map<string, Uint8Array>();
  for (const entry of zip.file(/^word\/media\//)) {
    images.set(entry.name.split('/').pop()!, await entry.async('uint8array'));
  }
  const rels = await readEntry(zip, 'word/_rels/document.xml.rels');
  const relMap = new Map<string, string>();
  if (rels) {
    for (const rel of asArray(xml.parse(rels).Relationships?.Relationship)) {
      const id = String(rel['@_Id'] ?? '');
      const target = String(rel['@_Target'] ?? '');
      if (id) relMap.set(id, target.replace(/^\.\//, 'word/'));
    }
  }

  const body = xml.parse(document).document?.body;
  const blocks: FlowBlock[] = [];
  for (const paragraph of asArray(body?.p)) {
    const style = String(paragraph.pPr?.pStyle?.['@_val'] ?? '');
    const numbered = paragraph.pPr?.numPr !== undefined;
    const runs = asArray(paragraph.r);
    let text = '';
    let bold = false;
    let size = 0;
    const embedded: string[] = [];
    for (const run of runs) {
      text += asArray(run.t).map((node: any) => String(node?.['#text'] ?? node ?? '')).join('');
      if (run.rPr?.b !== undefined) bold = true;
      const declared = Number(run.rPr?.sz?.['@_val'] ?? 0);
      if (declared) size = Math.max(size, declared / 2);
      const link = run.drawing?.inline?.graphic?.graphicData?.pic?.blipFill?.blip?.['@_embed'];
      if (link) embedded.push(String(link));
    }
    for (const rel of embedded) {
      const target = relMap.get(rel);
      const data = target ? images.get(target.split('/').pop()!) : undefined;
      if (data) {
        blocks.push({ kind: 'image', page: 0, box: { x: 0, y: 0, w: 0, h: 0 }, src: target ?? rel });
      }
    }
    const trimmed = text.replace(/\s+/g, ' ').trim();
    if (!trimmed) continue;
    const heading = /^(title|heading|标题)/i.exec(style);
    if (heading) {
      const level = Math.min(6, Math.max(1, Number(heading[0].replace(/\D/g, '')) || 1));
      blocks.push({ kind: 'heading', level, text: trimmed, page: 0 });
      continue;
    }
    if (numbered) {
      blocks.push({ kind: 'list', ordered: false, items: [trimmed], page: 0 });
      continue;
    }
    blocks.push({ kind: 'paragraph', text: trimmed, page: 0, bold });
  }
  return { blocks, images };
}

export interface ReadSheet {
  name: string;
  rows: string[][];
  colWidths: number[];
}

export async function readXlsx(bytes: Uint8Array): Promise<ReadSheet[]> {
  try {
    return await parseSheets(bytes);
  } catch (error) {
    if (error instanceof EngineError) throw error;
    throw new EngineError(
      'unreadable_file',
      `Excel 文件无法解析：${error instanceof Error ? error.message : String(error)}`,
      'error.notOfficePackage',
    );
  }
}

async function parseSheets(bytes: Uint8Array): Promise<ReadSheet[]> {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  // exceljs ships its own Buffer typing; the runtime accepts any bytes.
  await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const sheets: ReadSheet[] = [];
  workbook.eachSheet((ws) => {
    const rows: string[][] = [];
    ws.eachRow({ includeEmpty: false }, (row, rowIndex) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell, colIndex) => {
        while (cells.length < colIndex - 1) cells.push('');
        cells.push(cellText(cell.value));
      });
      while (cells.length < ws.columnCount) cells.push('');
      if (cells.some((cell) => cell !== '')) rows.push(cells);
      void rowIndex;
    });
    const colWidths: number[] = [];
    ws.columns.forEach((column, index) => {
      colWidths[index] = typeof column.width === 'number' ? column.width : 0;
    });
    if (rows.length) sheets.push({ name: ws.name, rows, colWidths });
  });
  return sheets;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.result === 'string' || typeof record.result === 'number') return String(record.result);
    if (Array.isArray(record.richText)) {
      return record.richText.map((part) => String((part as { text?: string }).text ?? '')).join('');
    }
  }
  return String(value);
}

export interface ReadSlide {
  texts: Array<{ text: string; xIn: number; yIn: number; wIn: number; hIn: number; size: number; bold: boolean }>;
  images: Uint8Array[];
}

export async function readPptx(bytes: Uint8Array): Promise<{ slides: ReadSlide[]; widthIn: number; heightIn: number }> {
  const zip = await unzip(bytes, 'PowerPoint 文档');
  const pres = await readEntry(zip, 'ppt/presentation.xml');
  const sldSz = pres ? xml.parse(pres).presentation?.presentationPr?.sldSz : undefined;
  const emu = 914400;
  const widthIn = sldSz ? Number(sldSz['@_cx'] ?? 0) / emu || 10 : 10;
  const heightIn = sldSz ? Number(sldSz['@_cy'] ?? 0) / emu || 7.5 : 7.5;

  const names = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)?.[0] ?? 0) - Number(b.match(/\d+/)?.[0] ?? 0));

  const slides: ReadSlide[] = [];
  for (const name of names) {
    const content = await readEntry(zip, name);
    if (!content) continue;
    const tree = xml.parse(content).sld;
    const texts: ReadSlide['texts'] = [];
    const images: Uint8Array[] = [];
    const walk = async (node: any): Promise<void> => {
      if (!node || typeof node !== 'object') return;
      if (node.sp) {
        for (const shape of asArray(node.sp)) {
          const xfrm = shape.spPr?.xfrm?.off;
          const ext = shape.spPr?.xfrm?.ext;
          let text = '';
          let size = 0;
          let bold = false;
          for (const run of asArray(shape.txBody?.p)) {
            for (const part of asArray((run as any).r)) {
              text += String((part as any).t?.['#text'] ?? (part as any).t ?? '');
              const props = (part as any).rPr;
              if (props) {
                if (String(props['@_b'] ?? '') === '1') bold = true;
                size = Math.max(size, Number(props['@_sz'] ?? 0) / 100);
              }
            }
          }
          const trimmed = text.replace(/\s+/g, ' ').trim();
          if (trimmed) {
            texts.push({
              text: trimmed,
              xIn: (Number(xfrm?.['@_x'] ?? 0) || 0) / emu,
              yIn: (Number(xfrm?.['@_y'] ?? 0) || 0) / emu,
              wIn: (Number(ext?.['@_cx'] ?? 0) || widthIn * emu) / emu,
              hIn: (Number(ext?.['@_cy'] ?? 0) || heightIn * emu) / emu,
              size: size || 14,
              bold,
            });
          }
        }
      }
      if (node.pic) {
        for (const pic of asArray(node.pic)) {
          const embed = String(pic.blipFill?.blip?.['@_embed'] ?? '');
          if (!embed) continue;
          const relsPath = name.replace('slides/', 'slides/_rels/') + '.rels';
          const rels = await readEntry(zip, relsPath);
          if (!rels) continue;
          for (const rel of asArray(xml.parse(rels).Relationships?.Relationship)) {
            if (String(rel['@_Id']) !== embed) continue;
            const target = String(rel['@_Target']).replace(/^\.\.\//, 'ppt/');
            const file = zip.file(target);
            if (file) images.push(await file.async('uint8array'));
          }
        }
      }
      for (const key of Object.keys(node)) {
        if (key.startsWith('@_')) continue;
        for (const child of asArray(node[key])) await walk(child);
      }
    };
    await walk(tree?.cSld?.spTree);
    slides.push({ texts, images });
  }
  return { slides, widthIn, heightIn };
}
