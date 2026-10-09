import JSZip from 'jszip';

const PT_TO_MM = 25.4 / 72;
const NS = 'http://www.ofdspec.org/2016';

export const ptToMm = (value: number): number => value * PT_TO_MM;

interface SampleOfdInput {
  title: string;
  author?: string;
  font: { name: string; bytes?: Uint8Array } | null;
  pages: Array<{
    width: number;
    height: number;
    texts: Array<{ text: string; x: number; y: number; width: number; size: number }>;
    images: Array<{ bytes: Uint8Array; name: string; x: number; y: number; width: number; height: number }>;
  }>;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Creates the small deterministic OFD fixture used by the sample corpus generator. */
export async function writeSampleOfd(input: SampleOfdInput): Promise<Uint8Array> {
  const zip = new JSZip();
  const stamp = new Date().toISOString().slice(0, 19);
  const docId = `${Date.now().toString(16).padStart(16, '0')}`;
  let nextId = 10;
  const ids = () => (nextId += 1);
  zip.file('OFD.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<ofd:OFD xmlns:ofd="${NS}" DocType="OFD" Version="1.0"><ofd:DocBody><ofd:DocInfo><ofd:DocID>${docId}</ofd:DocID><ofd:Creator>${escapeXml(input.author ?? 'PoTools')}</ofd:Creator><ofd:CreationDate>${stamp}</ofd:CreationDate></ofd:DocInfo><ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot></ofd:DocBody></ofd:OFD>`);
  const first = input.pages[0];
  const fontId = input.font ? ids() : 0;
  const mediaIds = new Map<string, number>();
  for (const page of input.pages) for (const image of page.images) if (!mediaIds.has(image.name)) mediaIds.set(image.name, ids());
  zip.file('Doc_0/Document.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<ofd:Document xmlns:ofd="${NS}"><ofd:CommonData><ofd:MaxUnitID>${nextId + 10}</ofd:MaxUnitID><ofd:PageArea><ofd:PhysicalBox>0 0 ${first?.width ?? 210} ${first?.height ?? 297}</ofd:PhysicalBox></ofd:PageArea><ofd:DocumentRes>DocumentRes.xml</ofd:DocumentRes></ofd:CommonData><ofd:Pages>${input.pages.map((_, index) => `<ofd:Page ID="${100 + index}" BaseLoc="Pages/Page_${index}/Content.xml"/>`).join('')}</ofd:Pages></ofd:Document>`);
  const fonts = input.font ? `<ofd:Fonts><ofd:Font ID="${fontId}" FontName="${escapeXml(input.font.name)}" Family="PoTools" Style="Normal" Weight="Normal">${input.font.bytes ? `<ofd:FontFile>fonts/${escapeXml(input.font.name)}</ofd:FontFile>` : ''}</ofd:Font></ofd:Fonts>` : '';
  const media = [...mediaIds.entries()].map(([name, id]) => `<ofd:MultiMedia ID="${id}" Type="Image"><ofd:MediaFile>Imgs/${escapeXml(name)}</ofd:MediaFile></ofd:MultiMedia>`).join('');
  zip.file('Doc_0/DocumentRes.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<ofd:Res xmlns:ofd="${NS}" BaseLoc="Res">${fonts}${media ? `<ofd:MultiMedias>${media}</ofd:MultiMedias>` : ''}</ofd:Res>`);
  if (input.font?.bytes) zip.file(`Doc_0/Res/fonts/${input.font.name}`, input.font.bytes);
  for (const page of input.pages) for (const image of page.images) zip.file(`Doc_0/Res/Imgs/${image.name}`, image.bytes);
  input.pages.forEach((page, pageIndex) => {
    const objects: string[] = [];
    for (const image of page.images) {
      const id = mediaIds.get(image.name)!;
      objects.push(`<ofd:ImageObject ID="${ids()}" CTM="${image.width} 0 0 ${image.height}" BBox="${image.x} ${image.y} ${image.width} ${image.height}" ResourceID="${id}"/>`);
    }
    for (const line of page.texts) {
      const chars = Array.from(line.text).length || 1;
      const delta = (line.width / chars).toFixed(3);
      objects.push(`<ofd:TextObject ID="${ids()}" XBound="${line.x.toFixed(2)}" YBound="${line.y.toFixed(2)}" Font="${fontId}" Size="${line.size.toFixed(2)}"><ofd:TextCode X="0" Y="0" DeltaX="1 ${delta}">${escapeXml(line.text)}</ofd:TextCode></ofd:TextObject>`);
    }
    zip.file(`Doc_0/Pages/Page_${pageIndex}/Content.xml`, `<?xml version="1.0" encoding="UTF-8"?>\n<ofd:Page xmlns:ofd="${NS}"><ofd:Content><ofd:Layer ID="${ids()}" Type="Body">${objects.join('')}</ofd:Layer></ofd:Content></ofd:Page>`);
    zip.file(`Doc_0/Pages/Page_${pageIndex}/Page.xml`, `<?xml version="1.0" encoding="UTF-8"?>\n<ofd:Page xmlns:ofd="${NS}"><ofd:Area><ofd:PhysicalBox>0 0 ${page.width.toFixed(2)} ${page.height.toFixed(2)}</ofd:PhysicalBox></ofd:Area></ofd:Page>`);
  });
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
