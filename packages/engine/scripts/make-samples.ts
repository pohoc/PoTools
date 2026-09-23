/**
 * Generates the sample corpus used by the tool harness and by manual UI
 * testing: text PDFs, a photo-heavy PDF, and loose images.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import fontkitAdaptor from '@pdf-lib/fontkit';
import sharp from 'sharp';
import { resolveFontPath } from '../src/lib/fonts.ts';
import type { FlowBlock } from '../src/lib/docmodel.ts';
import { writeDocx, writePptx, writeXlsx } from '../src/lib/office.ts';
import { ptToMm, writeOfd } from '../src/lib/ofd.ts';
import { openRaster } from '../src/lib/render.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../../../samples');
const FONT_PATH = resolveFontPath(null);

function prng(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

async function textDocument(
  fileName: string,
  pages: Array<{ size: [number, number]; heading: string; lines: string[] }>,
): Promise<void> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkitAdaptor);
  doc.setTitle('PoTools Sample');
  doc.setAuthor('PoTools');
  doc.setProducer('PoTools samples');
  const latin = await doc.embedFont(StandardFonts.Helvetica);
  const cjk = FONT_PATH ? await doc.embedFont(new Uint8Array(await readFileSafe(FONT_PATH)), { subset: true }) : latin;
  pages.forEach((entry, index) => {
    const page = doc.addPage(entry.size);
    const [width, height] = entry.size;
    page.drawRectangle({ x: 0, y: height - 90, width, height: 90, color: rgb(0.93, 0.95, 0.99) });
    page.drawText(entry.heading, {
      x: 48,
      y: height - 56,
      size: 26,
      font: /[^\x00-\xff]/.test(entry.heading) ? cjk : latin,
      color: rgb(0.08, 0.11, 0.2),
    });
    entry.lines.forEach((line, lineIndex) => {
      page.drawText(line, {
        x: 48,
        y: height - 130 - lineIndex * 26,
        size: 14,
        font: /[^\x00-\xff]/.test(line) ? cjk : latin,
        color: rgb(0.15, 0.18, 0.24),
      });
    });
    page.drawLine({
      start: { x: 48, y: 70 },
      end: { x: width - 48, y: 70 },
      thickness: 1,
      color: rgb(0.6, 0.64, 0.7),
    });
    page.drawText(`${index + 1} / ${pages.length}`, {
      x: width - 96,
      y: 44,
      size: 10,
      font: latin,
      color: rgb(0.4, 0.44, 0.5),
    });
  });
  const bytes = await doc.save({ useObjectStreams: true });
  await write(`${fileName}`, bytes);
}

async function readFileSafe(path: string): Promise<Buffer> {
  const { readFile } = await import('node:fs/promises');
  return readFile(path);
}

async function photo(fileName: string, width: number, height: number, seed: number): Promise<Uint8Array> {
  const random = prng(seed);
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      const wave = Math.sin((x + seed) / 90) * 40 + Math.cos((y - seed) / 70) * 40;
      raw[offset] = Math.max(0, Math.min(255, 120 + wave + random() * 70));
      raw[offset + 1] = Math.max(0, Math.min(255, 90 + wave * 0.6 + random() * 70));
      raw[offset + 2] = Math.max(0, Math.min(255, 150 + Math.sin((x * y) / 9000) * 60 + random() * 60));
    }
  }
  const buffer = await sharp(raw, { raw: { width, height, channels: 3 } })
    .composite([
      {
        input: Buffer.from(
          `<svg width="${width}" height="${height}"><text x="40" y="${height - 60}" font-family="sans-serif" font-size="${Math.round(height / 8)}" fill="white" opacity="0.85">${fileName}</text></svg>`,
        ),
        top: 0,
        left: 0,
      },
    ])
    .jpeg({ quality: 96, chromaSubsampling: '4:4:4' })
    .toBuffer();
  await write(fileName, new Uint8Array(buffer));
  return new Uint8Array(buffer);
}

async function write(name: string, bytes: Uint8Array): Promise<void> {
  await writeFile(resolve(OUT, name), bytes);
  process.stdout.write(`  ${name.padEnd(26)} ${(bytes.byteLength / 1024).toFixed(0)} KB\n`);
}

async function photoPdf(fileName: string, count: number): Promise<void> {
  const doc = await PDFDocument.create();
  doc.setTitle('Photo heavy sample');
  for (let index = 0; index < count; index += 1) {
    const jpeg = await photo(`__tmp-photo-${index}.jpg`, 1800, 1200, 1000 + index * 137);
    const image = await doc.embedJpg(jpeg);
    const page = doc.addPage([595.28, 841.89]);
    const scale = Math.min(595.28 / image.width, 700 / image.height);
    page.drawImage(image, {
      x: (595.28 - image.width * scale) / 2,
      y: 80,
      width: image.width * scale,
      height: image.height * scale,
    });
    page.drawText(`图片页 ${index + 1}`, { x: 48, y: 780, size: 22, font: await firstFont(doc), color: rgb(0.1, 0.1, 0.1) });
  }
  const bytes = await doc.save({ useObjectStreams: true });
  await write(fileName, bytes);
}

/** Fixtures for invoice tiling: mixed sizes, wide white margins, one rotated page. */
async function invoiceSamples(): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await firstFont(doc);
  const ink = rgb(0.12, 0.14, 0.2);

  const first = doc.addPage([595.28, 841.89]);
  first.drawRectangle({ x: 60, y: 690, width: 220, height: 110, color: ink });
  first.drawText('Invoice 001', { x: 72, y: 770, size: 15, font, color: rgb(1, 1, 1) });

  const slip = doc.addPage([320, 170]);
  slip.drawRectangle({ x: 14, y: 14, width: 292, height: 142, color: rgb(0.9, 0.92, 0.96) });
  slip.drawText('Taxi receipt', { x: 24, y: 90, size: 12, font, color: ink });

  const second = doc.addPage([595.28, 841.89]);
  second.drawRectangle({ x: 40, y: 700, width: 180, height: 80, color: ink });
  second.drawText('Invoice 002', { x: 52, y: 745, size: 14, font, color: rgb(1, 1, 1) });
  await write('sample-invoice.pdf', await doc.save({ useObjectStreams: true }));

  // A wide bar on a page flagged /Rotate 90: once upright it is a tall strip,
  // so the harness can tell whether the rotation was baked into the embed.
  const rotated = await PDFDocument.create();
  const page = rotated.addPage([400, 600]);
  page.drawRectangle({ x: 0, y: 20, width: 400, height: 40, color: rgb(0, 0, 0) });
  page.setRotation(degrees(90));
  await write('sample-rotated.pdf', await rotated.save());
}

/** OFD/Markdown fixtures, written by the same code paths the tools use. */
async function officeSamples(): Promise<void> {
  const fontPath = resolveFontPath(null);
  await write(
    'sample-office.ofd',
    await writeOfd({
      title: 'Sample OFD',
      author: 'PoTools',
      // Name-only keeps the fixture small; the importer falls back to a system font.
      font: fontPath ? { name: fontPath.split('/').pop()!.replace(/[^\w.-]/g, '_') } : null,
      pages: [
        {
          width: ptToMm(595.28),
          height: ptToMm(841.89),
          texts: [
            { text: 'OFD 往返测试', x: ptToMm(56), y: ptToMm(80), width: ptToMm(220), size: ptToMm(22) },
            { text: '第二行文字 with latin', x: ptToMm(56), y: ptToMm(120), width: ptToMm(260), size: ptToMm(11) },
          ],
          images: [],
        },
        {
          width: ptToMm(595.28),
          height: ptToMm(841.89),
          texts: [{ text: 'Page two 第二页', x: ptToMm(56), y: ptToMm(90), width: ptToMm(200), size: ptToMm(14) }],
          images: [],
        },
      ],
    }),
  );
  await write(
    'sample-office.md',
    Buffer.from(
      ['# 标题一', '', '正文段落，包含 **加粗** 与 `code` 以及 [链接](https://example.com)。', '', '- 列表甲', '- 列表乙', '', '## 小节', '', '```', 'const a = 1;', '```', '', '结束段落。', ''].join('\n'),
      'utf8',
    ),
  );
}

let cachedBytes: Uint8Array | null = null;
/** Fonts belong to one document, so only the file bytes are shared. */
async function firstFont(doc: PDFDocument) {
  doc.registerFontkit(fontkitAdaptor);
  if (!FONT_PATH) return doc.embedFont(StandardFonts.Helvetica);
  cachedBytes ??= new Uint8Array(await readFileSafe(FONT_PATH));
  return doc.embedFont(cachedBytes, { subset: true });
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  process.stdout.write(`writing samples to ${OUT}\n`);
  if (!FONT_PATH) process.stderr.write('warning: no CJK font found, samples use latin text only\n');

  await textDocument('sample-a.pdf', [
    {
      size: [595.28, 841.89],
      heading: '第一季度报告',
      lines: ['本页用于验证中文文本渲染。', 'Section 1 - Revenue grew 12% quarter over quarter.', '本地处理，文件不会离开这台电脑。', 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.'],
    },
    { size: [595.28, 841.89], heading: 'Page Two', lines: ['Tables, charts and more prose live here.', '第二页内容。'] },
    { size: [595.28, 841.89], heading: 'Page Three', lines: ['最后一页，用于测试拆分与页码。'] },
  ]);

  await textDocument('sample-b.pdf', [
    { size: [612, 792], heading: 'Appendix A', lines: ['Letter size document from a different producer.', '用于合并时混合页面尺寸的测试。'] },
    { size: [612, 792], heading: 'Appendix B', lines: ['Second letter page.'] },
  ]);

  const photoBytes = await photo('sample-photo-1.jpg', 1600, 1000, 4242);
  await photoPdf('sample-photos.pdf', 3);
  await invoiceSamples();
  await officeSamples();

  const png = await sharp(Buffer.from(photoBytes))
    .resize(700, 900, { fit: 'cover' })
    .png()
    .toBuffer();
  await write('sample-scan-2.png', new Uint8Array(png));

  const wide = await sharp(Buffer.from(await readFileSafe(resolve(OUT, 'sample-photo-1.jpg'))))
    .resize(1400, 500, { fit: 'cover' })
    .jpeg({ quality: 92 })
    .toBuffer();
  await write('sample-wide-3.jpg', new Uint8Array(wide));

  for (const stale of ['__tmp-photo-0.jpg', '__tmp-photo-1.jpg', '__tmp-photo-2.jpg']) {
    await rm(resolve(OUT, stale), { force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
