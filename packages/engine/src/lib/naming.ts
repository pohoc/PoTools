const DEFAULT_PATTERN = '{name}-{tool}';
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;

export interface NameContext {
  /** Base name of the source file, without extension. */
  name: string;
  tool: string;
  index?: number;
  total?: number;
  /** Compact page range, e.g. `1-3`. */
  range?: string;
}

export function safeFileName(value: string): string {
  const cleaned = value.replace(ILLEGAL, '_').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 120) || 'document';
}

export function baseName(fileName: string): string {
  const withoutDir = fileName.split(/[/\\]/).pop() ?? fileName;
  const dot = withoutDir.lastIndexOf('.');
  return dot > 0 ? withoutDir.slice(0, dot) : withoutDir;
}

export function extensionOf(fileName: string): string {
  const withoutDir = fileName.split(/[/\\]/).pop() ?? fileName;
  const dot = withoutDir.lastIndexOf('.');
  return dot > 0 ? withoutDir.slice(dot + 1).toLowerCase() : '';
}

export function renderName(pattern: string | undefined, ctx: NameContext, ext: string): string {
  const template = (pattern || DEFAULT_PATTERN).trim() || DEFAULT_PATTERN;
  const index = ctx.index ?? 1;
  const stamp = new Date();
  const date = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}`;
  const rendered = template
    .replace(/\{name\}/g, ctx.name)
    .replace(/\{tool\}/g, ctx.tool)
    .replace(/\{index\}/g, String(index))
    .replace(/\{i\}/g, pad(index))
    .replace(/\{total\}/g, String(ctx.total ?? 1))
    .replace(/\{range\}/g, ctx.range ?? '')
    .replace(/\{date\}/g, date)
    .replace(/\{time\}/g, `${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`);
  const trimmed = rendered.replace(/[-_.]{2,}/g, '-').replace(/^[-_.]+|[-_.]+$/g, '');
  return `${safeFileName(trimmed || ctx.name || 'document')}.${ext}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** `"report.pdf"` → `"report (2).pdf"` when a name is already taken. */
export function dedupe(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let counter = 2;
  while (taken.has(`${stem} (${counter})${ext}`)) counter += 1;
  return `${stem} (${counter})${ext}`;
}
