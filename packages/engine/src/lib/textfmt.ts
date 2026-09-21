import type { FlowBlock } from './docmodel.ts';

export type Inline = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: string;
};

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** `**bold**`, `*italic*`, `` `code` ``, `[text](url)` — nesting is not tracked. */
export function parseInline(value: string): Inline[] {
  const out: Inline[] = [];
  const pattern = /(\*\*([^*]+)\*\*)|(__([^_]+)__)|(\*([^*]+)\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value))) {
    if (match.index > cursor) out.push({ text: value.slice(cursor, match.index) });
    if (match[2]) out.push({ text: match[2], bold: true });
    else if (match[4]) out.push({ text: match[4], bold: true });
    else if (match[6]) out.push({ text: match[6], italic: true });
    else if (match[8]) out.push({ text: match[8], code: true });
    else if (match[10]) out.push({ text: match[10], link: match[11] });
    cursor = match.index + match[0].length;
  }
  if (cursor < value.length) out.push({ text: value.slice(cursor) });
  return out.length ? out : [{ text: value }];
}

export function inlineToHtml(parts: Inline[]): string {
  return parts
    .map((part) => {
      let html = escapeHtml(part.text);
      if (part.code) html = `<code>${html}</code>`;
      if (part.bold) html = `<strong>${html}</strong>`;
      if (part.italic) html = `<em>${html}</em>`;
      if (part.link) html = `<a href="${escapeHtml(part.link)}">${html}</a>`;
      return html;
    })
    .join('');
}

export function inlineToMarkdown(parts: Inline[]): string {
  return parts
    .map((part) => {
      if (part.code) return `\`${part.text}\``;
      if (part.bold) return `**${part.text}**`;
      if (part.italic) return `*${part.text}*`;
      if (part.link) return `[${part.text}](${part.link})`;
      return part.text;
    })
    .join('');
}

export interface ImageRef {
  /** Page number the image came from, used to name the file deterministically. */
  page: number;
  index: number;
  name: string;
  bytes: Uint8Array;
}

/**
 * Flow blocks to Markdown. `imageFor` returns the relative path for an image
 * block, or null to leave it out.
 */
export function flowToMarkdown(
  flow: FlowBlock[],
  imageFor: (block: Extract<FlowBlock, { kind: 'image' }>) => string | null,
): string {
  const lines: string[] = [];
  let imageIndex = 0;
  for (const block of flow) {
    switch (block.kind) {
      case 'heading':
        lines.push(`${'#'.repeat(Math.min(6, block.level))} ${block.text}`, '');
        break;
      case 'paragraph':
        lines.push(block.bold ? `**${block.text}**` : block.text, '');
        break;
      case 'list':
        block.items.forEach((item, index) => {
          lines.push(block.ordered ? `${index + 1}. ${item}` : `- ${item}`);
        });
        lines.push('');
        break;
      case 'image': {
        imageIndex += 1;
        const path = imageFor(block);
        if (path) lines.push(`![图片 ${imageIndex}](${path})`, '');
        break;
      }
      case 'pageBreak':
        lines.push('---', '');
        break;
      default:
        break;
    }
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

export function flowToHtml(
  flow: FlowBlock[],
  options: {
    title: string;
    imageFor: (block: Extract<FlowBlock, { kind: 'image' }>, index: number) => string | null;
  },
): string {
  const body: string[] = [];
  let imageIndex = 0;
  let openList: 'ul' | 'ol' | null = null;
  const closeList = (): void => {
    if (openList) body.push(`</${openList}>`);
    openList = null;
  };
  for (const block of flow) {
    switch (block.kind) {
      case 'heading':
        closeList();
        body.push(`<h${Math.min(6, block.level)}>${escapeHtml(block.text)}</h${Math.min(6, block.level)}>`);
        break;
      case 'paragraph':
        closeList();
        body.push(
          `<p>${block.bold ? `<strong>${escapeHtml(block.text)}</strong>` : escapeHtml(block.text)}</p>`,
        );
        break;
      case 'list': {
        const tag = block.ordered ? 'ol' : 'ul';
        if (openList !== tag) {
          closeList();
          body.push(`<${tag}>`);
          openList = tag;
        }
        block.items.forEach((item) => body.push(`  <li>${escapeHtml(item)}</li>`));
        break;
      }
      case 'image': {
        closeList();
        imageIndex += 1;
        const src = options.imageFor(block, imageIndex);
        if (src) body.push(`<figure><img src="${escapeHtml(src)}" alt="第 ${block.page} 页"></figure>`);
        break;
      }
      case 'pageBreak':
        closeList();
        body.push('<hr>');
        break;
      default:
        break;
    }
  }
  closeList();
  return [
    '<!doctype html>',
    '<html lang="zh-CN"><head><meta charset="utf-8">',
    `<title>${escapeHtml(options.title)}</title>`,
    '<style>body{max-width:46em;margin:3em auto;padding:0 1.2em;font:15px/1.75 -apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;color:#1f2430}',
    'img{max-width:100%;height:auto}h1,h2,h3{line-height:1.35}hr{margin:2.5em 0;border:0;border-top:1px solid #dfe3ea}',
    'figure{margin:1.5em 0}code{background:#f2f4f8;padding:.1em .35em;border-radius:4px}</style></head><body>',
    body.join('\n'),
    '</body></html>',
    '',
  ].join('\n');
}

export const DELIMITERS: Record<string, string> = {
  comma: ',',
  semicolon: ';',
  tab: '\t',
};

export function rowsToCsv(rows: string[][], delimiter: string): string {
  const escape = (cell: string): string =>
    /[",\n;]|\t/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
  // Excel needs the BOM to read UTF-8 CSV correctly.
  return `﻿${rows.map((row) => row.map(escape).join(delimiter)).join('\r\n')}\r\n`;
}

function rtfEscape(value: string): string {
  let out = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (char === '\\' || char === '{' || char === '}') {
      out += `\\${char}`;
      continue;
    }
    const code = value.charCodeAt(index);
    // RTF \u takes a signed 16-bit unit; surrogate halves stay as written.
    if (char === '\n') out += '\\par\n';
    else if (code > 126) out += `\\u${code > 32767 ? code - 65536 : code}?`;
    else out += char;
  }
  return out;
}

export function flowToRtf(flow: FlowBlock[]): string {
  const parts: string[] = [];
  for (const block of flow) {
    switch (block.kind) {
      case 'heading': {
        const size = Math.max(20, 44 - block.level * 6);
        parts.push(`\\pard\\sb240\\sa120\\b\\fs${size} ${rtfEscape(block.text)}\\b0\\par`);
        break;
      }
      case 'paragraph':
        parts.push(
          `\\pard\\sa120${block.bold ? '\\b' : ''} ${rtfEscape(block.text)}${block.bold ? '\\b0' : ''}\\par`,
        );
        break;
      case 'list':
        block.items.forEach((item) => {
          parts.push(`\\pard\\fi-360\\li360 ${block.ordered ? '-' : '•'} ${rtfEscape(item)}\\par`);
        });
        break;
      case 'pageBreak':
        parts.push('\\page');
        break;
      default:
        break;
    }
  }
  return `{\\rtf1\\ansi\\ansicpg1252\\deff0\\deflang1033
{\\fonttbl{\\f0\\froman\\fcharset0 Times New Roman;}{\\f1\\fnil\\fcharset134 SimSun;}}
\\viewkind4\\uc1
${parts.join('\n')}
}
`;
}

export interface MarkdownDoc {
  title: string | null;
  blocks: FlowBlock[];
}

/**
 * Line-oriented Markdown reader: headings, lists, fenced code, quotes, rules,
 * images and paragraphs with inline marks. Enough for notes and receipts.
 */
export function parseMarkdown(text: string): MarkdownDoc {
  const blocks: FlowBlock[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let title: string | null = null;
  let list: { ordered: boolean; items: string[] } | null = null;
  let paragraph: string[] = [];
  let code: string[] | null = null;

  const flushParagraph = (): void => {
    if (!paragraph.length) return;
    const joined = paragraph.join(' ').trim();
    paragraph = [];
    if (!joined) return;
    if (!title) title = joined.slice(0, 80);
    blocks.push({ kind: 'paragraph', text: joined, page: 0, bold: false });
  };
  const flushList = (): void => {
    if (!list) return;
    blocks.push({ kind: 'list', ordered: list.ordered, items: list.items, page: 0 });
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const fence = /^```(\w*)$/.exec(line.trim());
    if (fence) {
      if (code) {
        blocks.push({ kind: 'paragraph', text: code.join('\n'), page: 0, bold: false });
        code = null;
      } else {
        flushParagraph();
        flushList();
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(raw);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    if (/^(---+|\*\*\*+|___+)\s*$/.test(line.trim())) {
      flushParagraph();
      flushList();
      blocks.push({ kind: 'pageBreak' });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1]!.length;
      const textValue = heading[2]!.trim();
      if (level === 1 && !title) title = textValue;
      blocks.push({ kind: 'heading', level, text: textValue, page: 0 });
      continue;
    }
    const image = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/.exec(line.trim());
    if (image) {
      flushParagraph();
      flushList();
      blocks.push({ kind: 'image', page: 0, box: { x: 0, y: 0, w: 0, h: 0 }, src: image[2]!.trim(), alt: image[1] });
      continue;
    }
    const bullet = /^\s*([-*+•]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      const ordered = /^\d/.test(bullet[1]!);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push(bullet[2]!.trim());
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flushList();
      paragraph.push(quote[1]!.trim());
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();
  if (code) blocks.push({ kind: 'paragraph', text: code.join('\n'), page: 0, bold: false });
  return { title, blocks };
}
