import JSZip from 'jszip';
import type { FlowBlock } from './docmodel.ts';
import { escapeHtml } from './textfmt.ts';

export interface EpubImage {
  name: string;
  bytes: Uint8Array;
}

export interface EpubChapter {
  title: string;
  blocks: FlowBlock[];
}

export interface EpubInput {
  title: string;
  author: string;
  chapters: EpubChapter[];
  images: Map<string, EpubImage>;
}

const CSS = `body{font-family:serif;line-height:1.6;margin:1.5em;color:#1f2430}
h1,h2,h3{line-height:1.3}img{max-width:100%;height:auto}
hr{margin:2em 0;border:0;border-top:1px solid #ccc}
.page{color:#8a93a5;font-size:.8em;margin-top:2em}
`;

function chapterXhtml(chapter: EpubChapter, hasImages: boolean): string {
  const body: string[] = [];
  let openList: 'ul' | 'ol' | null = null;
  const closeList = (): void => {
    if (openList) body.push(`</${openList}>`);
    openList = null;
  };
  let imageIndex = 0;
  for (const block of chapter.blocks) {
    switch (block.kind) {
      case 'heading': {
        closeList();
        const level = Math.min(6, Math.max(2, block.level));
        body.push(`<h${level}>${escapeHtml(block.text)}</h${level}>`);
        break;
      }
      case 'paragraph':
        closeList();
        body.push(block.bold ? `<p><strong>${escapeHtml(block.text)}</strong></p>` : `<p>${escapeHtml(block.text)}</p>`);
        break;
      case 'list': {
        const tag = block.ordered ? 'ol' : 'ul';
        if (openList !== tag) {
          closeList();
          body.push(`<${tag}>`);
          openList = tag;
        }
        block.items.forEach((item) => body.push(`<li>${escapeHtml(item)}</li>`));
        break;
      }
      case 'image': {
        closeList();
        const name = block.src;
        if (name && hasImages) {
          imageIndex += 1;
          body.push(`<figure><img src="../images/${escapeHtml(name)}" alt="figure ${imageIndex}"/></figure>`);
        }
        break;
      }
      case 'pageBreak':
        closeList();
        body.push('<hr/>');
        break;
      default:
        break;
    }
  }
  closeList();
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh">
<head><title>${escapeHtml(chapter.title)}</title><link rel="stylesheet" type="text/css" href="../style.css"/></head>
<body>${body.join('\n')}</body></html>
`;
}

/** Writes an EPUB 3 archive (with an NCX fallback) from the shared flow model. */
export async function writeEpub(input: EpubInput): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE', createFolders: false });
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
  );
  zip.file('OEBPS/style.css', CSS);

  const chapters = input.chapters.length ? input.chapters : [{ title: input.title, blocks: [] }];
  const uid = `urn:uuid:${Date.now().toString(36)}`;
  const manifestItems = chapters
    .map((_, index) => `<item id="ch${index}" href="text/chapter${index + 1}.xhtml" media-type="application/xhtml+xml"/>`)
    .join('');
  const imageItems = [...input.images.keys()]
    .map((name, index) => {
      const media = name.endsWith('.png') ? 'image/png' : name.match(/\.jpe?g$/) ? 'image/jpeg' : 'image/webp';
      return `<item id="img${index}" href="images/${escapeHtml(name)}" media-type="${media}"/>`;
    })
    .join('');
  const spine = chapters
    .map((_, index) => `<itemref idref="ch${index}" linear="yes"/>`)
    .join('');

  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="zh">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="pub-id">${escapeHtml(uid)}</dc:identifier>
<dc:title>${escapeHtml(input.title)}</dc:title>
<dc:creator>${escapeHtml(input.author)}</dc:creator>
<dc:language>zh</dc:language>
<meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, '')}</meta>
</metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>${manifestItems}${imageItems}</manifest>
<spine toc="ncx">${spine}</spine>
</package>`,
  );

  zip.file(
    'OEBPS/nav.xhtml',
    `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh"><head><title>${escapeHtml(input.title)}</title></head><body><nav epub:type="toc" id="toc"><h1>${escapeHtml(input.title)}</h1><ol>${chapters
      .map((chapter, index) => `<li><a href="text/chapter${index + 1}.xhtml">${escapeHtml(chapter.title)}</a></li>`)
      .join('')}</ol></nav></body></html>`,
  );

  zip.file(
    'OEBPS/toc.ncx',
    `<?xml version="1.0" encoding="UTF-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${escapeHtml(uid)}"/></head><docTitle><text>${escapeHtml(input.title)}</text></docTitle><navMap>${chapters
      .map(
        (chapter, index) =>
          `<navPoint id="np${index}" playOrder="${index + 1}"><navLabel><text>${escapeHtml(chapter.title)}</text></navLabel><content src="text/chapter${index + 1}.xhtml"/></navPoint>`,
      )
      .join('')}</navMap></ncx>`,
  );

  chapters.forEach((chapter, index) => {
    zip.file(`OEBPS/text/chapter${index + 1}.xhtml`, chapterXhtml(chapter, input.images.size > 0));
  });
  for (const [name, image] of input.images) {
    zip.file(`OEBPS/images/${name}`, image.bytes);
  }

  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

/** Splits a flow into chapters by heading level or per source page. */
export function chapterize(flow: FlowBlock[], by: 'heading' | 'page'): EpubChapter[] {
  const chapters: EpubChapter[] = [];
  let current: EpubChapter | null = null;
  const open = (title: string): EpubChapter => {
    current = { title, blocks: [] };
    chapters.push(current);
    return current;
  };
  const pageOf = (block: FlowBlock): number => (block.kind === 'pageBreak' ? 0 : block.page);
  let lastPage = 0;
  for (const block of flow) {
    if (block.kind === 'pageBreak') continue;
    if (by === 'heading') {
      if (block.kind === 'heading' && block.level <= 2) {
        open(block.text);
        continue;
      }
      if (!current) open('正文');
    } else {
      const page = pageOf(block);
      if (!current || page !== lastPage) open(`第 ${page || chapters.length + 1} 页`);
      lastPage = page;
    }
    current!.blocks.push(block);
  }
  if (!chapters.length) chapters.push({ title: '正文', blocks: flow });
  return chapters;
}
