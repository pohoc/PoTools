import type { DomainMessages } from '../messages.ts';

export const ocrMessages: DomainMessages = {
  'zh-CN': {
    'ocr.page': '第 {page} 页',
    'ocr.warning.empty': '{name}：没有识别到文字。',
    'ocr.warning.noTable': '{name} 第 {page} 页：没有识别到表格内容。',
    'ocr.warning.review': 'OCR 表格按文字位置自动推断行列，请打开工作簿检查表头、列顺序和数字。',
    'ocr.error.empty': '没有可识别的页面。',
    'ocr.error.noTable': '没有识别到可导出的表格内容。',
  },
  en: {
    'ocr.page': 'Page {page}',
    'ocr.warning.empty': '{name}: no text was recognized.',
    'ocr.warning.noTable': '{name}, page {page}: no table content was recognized.',
    'ocr.warning.review': 'Rows and columns are inferred from OCR text positions. Review the workbook for headers, column order, and numbers.',
    'ocr.error.empty': 'There are no pages to recognize.',
    'ocr.error.noTable': 'No table content was recognized for export.',
  },
};
