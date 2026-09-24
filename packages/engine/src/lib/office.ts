import { Document, HeadingLevel, ImageRun, Packer, PageBreak, Paragraph, TextRun } from 'docx';
import type { FlowBlock } from './docmodel.ts';
export { writePptx } from './pptx.ts';

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

/** Builds the shared DOCX document model used by Node and browser writers. */
async function buildDocx(input: DocxInput): Promise<Document> {
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

  return new Document({
    title: input.title,
    creator: 'PoTools',
    description: 'Converted with PoTools',
    sections: [{ properties: {}, children }],
  });
}

/** Builds a .docx using Node's Buffer-backed packer. */
export async function writeDocx(input: DocxInput): Promise<Uint8Array> {
  return new Uint8Array(await Packer.toBuffer(await buildDocx(input)));
}

/** Builds the same .docx using the browser Blob packer for Worker execution. */
export async function writeBrowserDocx(input: DocxInput): Promise<Uint8Array> {
  const blob = await Packer.toBlob(await buildDocx(input));
  return new Uint8Array(await blob.arrayBuffer());
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
