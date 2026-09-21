import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { EngineError } from '../errors.ts';

const PT_TO_MM = 25.4 / 72;
const NS = 'http://www.ofdspec.org/2016';

const parser = new XMLParser({
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

function text(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'object' ? String((value as Record<string, unknown>)['#text'] ?? '') : String(value);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function mmToPt(value: number): number {
  return value / PT_TO_MM;
}

export function ptToMm(value: number): number {
  return value * PT_TO_MM;
}

export interface OfdText {
  text: string;
  /** Millimetres from the page's top-left corner. */
  x: number;
  y: number;
  width: number;
  size: number;
}

export interface OfdImage {
  bytes: Uint8Array;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OfdPageInput {
  width: number;
  height: number;
  texts: OfdText[];
  images: OfdImage[];
}

export interface OfdFontInput {
  name: string;
  /** Omitted when the font is too large to embed; readers fall back by name. */
  bytes?: Uint8Array;
}

export interface OfdInput {
  title: string;
  author?: string;
  font: OfdFontInput | null;
  pages: OfdPageInput[];
}

/**
 * Packs pages into an OFD (GB/T 33190) zip: one layer per page holding either
 * text objects (when a CJK font is bundled) or a full-page image.
 */
export async function writeOfd(input: OfdInput): Promise<Uint8Array> {
  const zip = new JSZip();
  const stamp = new Date().toISOString().slice(0, 19);
  const docId = `${Date.now().toString(16).padStart(16, '0')}`;
  let nextId = 10;
  const ids = () => (nextId += 1);

  zip.file(
    'OFD.xml',
    `<?xml version="1.0" encoding="UTF-8"?>\n<ofd:OFD xmlns:ofd="${NS}" DocType="OFD" Version="1.0"><ofd:DocBody><ofd:DocInfo><ofd:DocID>${docId}</ofd:DocID><ofd:Creator>PoTools</ofd:Creator><ofd:CreationDate>${stamp}</ofd:CreationDate></ofd:DocInfo><ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot></ofd:DocBody></ofd:OFD>`,
  );

  const first = input.pages[0];
  const fontId = input.font ? ids() : 0;
  const mediaIds = new Map<string, number>();
  for (const page of input.pages) {
    for (const image of page.images) if (!mediaIds.has(image.name)) mediaIds.set(image.name, ids());
  }

  zip.file(
    'Doc_0/Document.xml',
    `<?xml version="1.0" encoding="UTF-8"?>\n<ofd:Document xmlns:ofd="${NS}"><ofd:CommonData><ofd:MaxUnitID>${nextId + 10}</ofd:MaxUnitID><ofd:PageArea><ofd:PhysicalBox>0 0 ${first?.width ?? 210} ${first?.height ?? 297}</ofd:PhysicalBox></ofd:PageArea><ofd:DocumentRes>DocumentRes.xml</ofd:DocumentRes></ofd:CommonData><ofd:Pages>${input.pages
      .map((_, index) => `<ofd:Page ID="${100 + index}" BaseLoc="Pages/Page_${index}/Content.xml"/>`)
      .join('')}</ofd:Pages></ofd:Document>`,
  );

  const fonts = input.font
    ? `<ofd:Fonts><ofd:Font ID="${fontId}" FontName="${escapeXml(input.font.name)}" Family="PoTools" Style="Normal" Weight="Normal">${
        input.font.bytes ? `<ofd:FontFile>fonts/${escapeXml(input.font.name)}</ofd:FontFile>` : ''
      }</ofd:Font></ofd:Fonts>`
    : '';
  const media = [...mediaIds.entries()]
    .map(
      ([name, id]) =>
        `<ofd:MultiMedia ID="${id}" Type="Image"><ofd:MediaFile>Imgs/${escapeXml(name)}</ofd:MediaFile></ofd:MultiMedia>`,
    )
    .join('');
  zip.file(
    'Doc_0/DocumentRes.xml',
    `<?xml version="1.0" encoding="UTF-8"?>\n<ofd:Res xmlns:ofd="${NS}" BaseLoc="Res">${fonts}${media ? `<ofd:MultiMedias>${media}</ofd:MultiMedias>` : ''}</ofd:Res>`,
  );
  if (input.font?.bytes) zip.file(`Doc_0/Res/fonts/${input.font.name}`, input.font.bytes);
  for (const page of input.pages) {
    for (const image of page.images) zip.file(`Doc_0/Res/Imgs/${image.name}`, image.bytes);
  }

  input.pages.forEach((page, pageIndex) => {
    const objects: string[] = [];
    for (const image of page.images) {
      const id = mediaIds.get(image.name)!;
      objects.push(
        `<ofd:ImageObject ID="${ids()}" CTM="${image.width} 0 0 ${image.height}" BBox="${image.x} ${image.y} ${image.width} ${image.height}" ResourceID="${id}"/>`,
      );
    }
    for (const line of page.texts) {
      const chars = Array.from(line.text).length || 1;
      const delta = (line.width / chars).toFixed(3);
      objects.push(
        `<ofd:TextObject ID="${ids()}" XBound="${line.x.toFixed(2)}" YBound="${line.y.toFixed(2)}" Font="${fontId}" Size="${line.size.toFixed(2)}"><ofd:TextCode X="0" Y="0" DeltaX="1 ${delta}">${escapeXml(line.text)}</ofd:TextCode></ofd:TextObject>`,
      );
    }
    zip.file(
      `Doc_0/Pages/Page_${pageIndex}/Content.xml`,
      `<?xml version="1.0" encoding="UTF-8"?>\n<ofd:Page xmlns:ofd="${NS}"><ofd:Content><ofd:Layer ID="${ids()}" Type="Body">${objects.join('')}</ofd:Layer></ofd:Content></ofd:Page>`,
    );
    // BaseLoc points at a directory, so the page size lives beside Content.xml.
    zip.file(
      `Doc_0/Pages/Page_${pageIndex}/Page.xml`,
      `<?xml version="1.0" encoding="UTF-8"?>\n<ofd:Page xmlns:ofd="${NS}"><ofd:Area><ofd:PhysicalBox>0 0 ${page.width.toFixed(2)} ${page.height.toFixed(2)}</ofd:PhysicalBox></ofd:Area></ofd:Page>`,
    );
  });

  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  return bytes;
}

export interface OfdPageOut {
  width: number;
  height: number;
  texts: Array<{ text: string; x: number; y: number; size: number; advance: number; font?: string }>;
  images: Array<{ bytes: Uint8Array; x: number; y: number; width: number; height: number }>;
}

export interface OfdDoc {
  pages: OfdPageOut[];
  fonts: Map<string, Uint8Array>;
}

function boxOf(value: unknown): [number, number, number, number] {
  const parts = text(value)
    .split(/\s+/)
    .map((item) => Number(item) || 0);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 0];
}

/** Reads an OFD package back into page geometry, text runs and images. */
export async function readOfd(bytes: Uint8Array): Promise<OfdDoc> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new EngineError('unreadable_file', '文件不是有效的 OFD 包', 'error.notOfd');
  }
  const read = async (path: string): Promise<string> => {
    const entry = zip.file(path) ?? zip.file(path.replace(/\\/g, '/'));
    return entry ? entry.async('string') : '';
  };
  const root = parser.parse(await read('OFD.xml')).OFD;
  const body = root?.DocBody ?? root?.ofd?.DocBody;
  const docRoot = text(body?.DocRoot) || 'Document.xml';
  const basePath = docRoot.includes('/') ? docRoot.slice(0, docRoot.lastIndexOf('/')) : '';
  const document = parser.parse(await read(docRoot)).Document;
  const common = document?.CommonData ?? {};
  const docBox = boxOf(common.PageArea?.PhysicalBox);
  const resPath = text(common.DocumentRes);
  const resDir = resPath ? `${basePath}/${resPath}` : '';
  const resBase = resDir ? resDir.slice(0, resDir.lastIndexOf('/')) : '';
  const res = resDir ? parser.parse(await read(resDir)).Res : null;

  const fonts = new Map<string, Uint8Array>();
  const fontIds = new Map<number, string>();
  for (const font of asArray(res?.Fonts?.Font)) {
    const file = text(font.FontFile);
    if (!file) continue;
    const entry = zip.file(`${resBase}/${file}`);
    if (!entry) continue;
    const name = file.split('/').pop()!;
    fonts.set(name, await entry.async('uint8array'));
    fontIds.set(Number(font['@_ID']), name);
  }
  const media = new Map<number, string>();
  for (const item of asArray(res?.MultiMedias?.MultiMedia)) {
    const file = text(item.MediaFile);
    if (file) media.set(Number(item['@_ID']), file);
  }

  const pageEntries = [
    ...asArray(document?.Pages?.Page).map((page: any) => ({
      id: Number(page['@_ID']),
      base: text(page['@_BaseLoc']) || 'content.xml',
    })),
  ];

  const pages: OfdPageOut[] = [];
  for (const entry of pageEntries) {
    // BaseLoc may name the content file or the directory that holds it.
    const base = entry.base || 'Content.xml';
    const dir = base.includes('/') ? base.slice(0, base.lastIndexOf('/')) : '';
    const at = (file: string): string => [basePath, dir, file].filter(Boolean).join('/');
    const pageXml = await read(at('Content.xml'));
    const pageMeta = await read(at('Page.xml'));
    const metaTree = pageMeta ? parser.parse(pageMeta).Page : null;
    const box = metaTree?.Area?.PhysicalBox ? boxOf(metaTree.Area.PhysicalBox) : docBox;
    const page: OfdPageOut = {
      width: mmToPt(box[2] || 210),
      height: mmToPt(box[3] || 297),
      texts: [],
      images: [],
    };
    const tree = pageXml ? parser.parse(pageXml).Page : null;
    const layers = asArray(tree?.Content?.Layer);
    for (const layer of layers) {
      for (const image of asArray(layer.ImageObject)) {
        const file = media.get(Number(image['@_ResourceID']));
        if (!file) continue;
        const data = await zip.file(`${resBase}/${file}`)?.async('uint8array');
        if (!data) continue;
        const rect = boxOf(image.BBox);
        page.images.push({
          bytes: data,
          x: mmToPt(rect[0]),
          y: mmToPt(rect[1]),
          width: mmToPt(rect[2] || rect[0]),
          height: mmToPt(rect[3] || rect[1]),
        });
      }
      for (const object of asArray(layer.TextObject)) {
        const size = Number(object['@_Size'] ?? 3) || 3;
        const code = asArray(object.TextCode)[0] as Record<string, unknown> | undefined;
        const value = text(code);
        if (!value) continue;
        const delta = text(code?.['@_DeltaX'])
          .split(/\s+/)
          .map(Number);
        let advance = size * 0.6;
        if (delta.length >= 2) advance = delta[1] ?? advance;
        const fontName = fontIds.get(Number(object['@_Font']));
        page.texts.push({
          text: value,
          x: mmToPt(Number(object['@_XBound'] ?? 0) + Number(code?.['@_X'] ?? 0)),
          y: mmToPt(Number(object['@_YBound'] ?? 0) + Number(code?.['@_Y'] ?? 0)),
          size: mmToPt(size),
          advance: mmToPt(advance),
          font: fontName,
        });
      }
    }
    pages.push(page);
  }
  return { pages, fonts };
}

export { NS, PT_TO_MM };
