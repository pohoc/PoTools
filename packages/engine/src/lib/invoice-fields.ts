import type { InvoiceScanEntry } from '@potools/core';

export function parseInvoiceFields(text: string): InvoiceScanEntry['fields'] {
  const normalized = text.replace(/\r/g, '').replace(/[ \t]+/g, ' ');
  return {
    date: findValue(normalized, /(?:开票日期|开票时间|填开日期)\s*[:：]?\s*((?:20\d{2})\s*[年./-]\s*\d{1,2}\s*[月./-]\s*\d{1,2}\s*日?)/),
    seller: findValue(normalized, /(?:销售方名称|销方名称|销售方)\s*[:：]?\s*([^\n\r]{2,80})/),
    buyer: findValue(normalized, /(?:购买方名称|购方名称|购买方)\s*[:：]?\s*([^\n\r]{2,80})/),
    invoiceNo: findValue(normalized, /(?:发票号码|票据号码|发票 No\.?|发票编号)\s*[:：]?\s*([0-9０-９]{8,30})/i),
    amount: findValue(normalized, /(?:价税合计|小写合计|合计金额)\s*(?:\([^\n)]*\))?\s*[:：]?\s*[¥￥]?\s*([0-9,]+\.\d{2})/),
    type: /数电发票|电子发票/.test(normalized) ? '电子发票' : /增值税专用发票/.test(normalized) ? '增值税专用发票' : /增值税普通发票/.test(normalized) ? '增值税普通发票' : '',
  };
}

function findValue(text: string, pattern: RegExp): string {
  const value = pattern.exec(text)?.[1]?.trim() ?? '';
  return value.replace(/[\s|]+$/g, '').slice(0, 160);
}
