import { baseName, renderName } from '../lib/naming.ts';
import { bool, num } from '../lib/options.ts';
import { writeBrowserXlsx } from '../lib/xlsx-browser.ts';
import type { ToolImpl } from '../types.ts';
import { readBrowserPdfTextPages, rowsOf } from './pdf-text-export-browser.ts';

function sheetName(value: string, index: number): string {
  const sanitized = value.replace(/[\\/?*\[\]:]/g, '-').replace(/^'+|'+$/g, '').slice(0, 31);
  return sanitized || `Sheet${index + 1}`;
}

export const embeddedPdfToExcelTool: ToolImpl = {
  id: 'pdf-to-excel',
  async run(ctx) {
    const sheetPerPage = bool(ctx.options, 'sheetPerPage');
    const gap = num(ctx.options, 'columnGap');
    let produced = 0;
    for (const [index, input] of ctx.inputs.entries()) {
      const pages = await readBrowserPdfTextPages(input.bytes, ctx.globals.password);
      const stem = baseName(input.name);
      const sheets = sheetPerPage
        ? pages.map((page) => ({ name: sheetName(`${stem} ${page.page}`, page.page), rows: rowsOf(page, gap) }))
        : [{ name: sheetName(stem, 1), rows: pages.flatMap((page) => rowsOf(page, gap)) }];
      const populated = sheets.filter((sheet) => sheet.rows.length > 0);
      const bytes = await writeBrowserXlsx(populated);
      await ctx.emit({
        name: renderName(ctx.namePattern, { name: stem, tool: 'excel' }, 'xlsx'),
        kind: 'xlsx',
        bytes,
        sourceFileId: input.id,
      });
      produced += 1;
      ctx.report({ percent: Math.round(((index + 1) / ctx.inputs.length) * 100), current: index + 1, total: ctx.inputs.length });
    }
    return { extra: { workbooks: produced } };
  },
};
