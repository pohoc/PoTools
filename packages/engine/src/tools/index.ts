import type { ToolId } from '@potools/core';
import type { ToolImpl } from '../types.ts';
import { pageTools } from './pages.ts';
import { markupTools } from './markup.ts';
import { docTools } from './doc.ts';
import { convertTools } from './convert.ts';
import { geometryTools } from './geometry.ts';
import { extractTools } from './extract.ts';
import { invoiceTools } from './invoice.ts';
import { exportTools } from './export.ts';
import { importTools } from './import.ts';
import { imageTools } from './image.ts';
import { timeTools } from './time.ts';
import { cryptoTools } from './crypto.ts';
import { developerTools } from './developer.ts';
import { financeTools } from './finance.ts';
import { ocrTools } from './ocr.ts';

export const TOOL_IMPLS: ToolImpl[] = [
  ...pageTools,
  ...geometryTools,
  ...markupTools,
  ...docTools,
  ...convertTools,
  ...extractTools,
  ...invoiceTools,
  ...exportTools,
  ...importTools,
  ...imageTools,
  ...timeTools,
  ...cryptoTools,
  ...developerTools,
  ...financeTools,
  ...ocrTools,
];

export const TOOL_IMPL_MAP = TOOL_IMPLS.reduce(
  (acc, tool) => {
    acc[tool.id as ToolId] = tool;
    return acc;
  },
  {} as Record<ToolId, ToolImpl>,
);
