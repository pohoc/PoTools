import type { ToolId } from '@potools/core';
import type { ToolImpl } from './types.ts';
import { pageTools } from './tools/pages.ts';
import { geometryTools } from './tools/geometry.ts';
import { financeTools } from './tools/finance.ts';
import { embeddedDeveloperFileTools, embeddedDeveloperTools, embeddedNetworkTools } from './tools/developer.ts';
import { embeddedCryptoEncodingTools } from './tools/crypto-encoding.ts';
import { embeddedCryptoPrimitiveTools } from './tools/crypto-primitives-browser.ts';
import { cryptoEncodingTools } from './tools/crypto-encoding.ts';
import { timeTools } from './tools/time.ts';
import { embeddedAesTool } from './tools/crypto-aes-browser.ts';
import { embeddedImageTools } from './tools/image-browser.ts';
import { embeddedOcrTools } from './tools/ocr-browser.ts';
import { embeddedCryptoJwtTools } from './tools/crypto-jwt-browser.ts';
import { embeddedRsaTool } from './tools/crypto-rsa-browser.ts';
import { embeddedX509Tool } from './tools/crypto-x509-browser.ts';
import { embeddedRegexTool } from './tools/developer-regex-browser.ts';
import { embeddedExtractTextTool } from './tools/extract-text-browser.ts';
import { embeddedRemoveBlankTool } from './tools/remove-blank-browser.ts';
import { embeddedExtractImagesTool } from './tools/extract-images-browser.ts';
import { embeddedRepairTool } from './tools/repair-browser.ts';
import { embeddedConvertTools } from './tools/convert-browser.ts';
import { embeddedCropTool } from './tools/crop-browser.ts';
import { embeddedCompressTool } from './tools/compress-browser.ts';
import { embeddedMarkupTools } from './tools/markup-browser.ts';
import { embeddedMetadataTool } from './tools/metadata-browser.ts';
import { embeddedPdfTextExportTools } from './tools/pdf-text-export-browser.ts';
import { embeddedPdfToExcelTool } from './tools/pdf-to-excel-browser.ts';
import { embeddedPdfToEpubTool } from './tools/epub-browser.ts';
import { embeddedOfdToPdfTool } from './tools/ofd-to-pdf-browser.ts';
import { embeddedPdfToPptTool } from './tools/pdf-to-ppt-browser.ts';
import { embeddedPdfToWordTool } from './tools/pdf-to-word-browser.ts';
import { embeddedPdfToOfdTool } from './tools/pdf-to-ofd-browser.ts';
import { embeddedMarkdownToPdfTool } from './tools/markdown-to-pdf-browser.ts';
import { invoiceTools } from './tools/invoice.ts';

function byToolId(tools: readonly ToolImpl[]): Partial<Record<ToolId, ToolImpl>> {
  return tools.reduce<Partial<Record<ToolId, ToolImpl>>>((registry, tool) => {
    if (registry[tool.id]) throw new Error(`Duplicate embedded tool registration: ${tool.id}`);
    registry[tool.id] = tool;
    return registry;
  }, {});
}

/** Implementations routed by tool.run through the in-process RPC dispatcher. */
export const embeddedTextToolImplementations = byToolId([
  ...timeTools, ...financeTools, ...embeddedDeveloperTools, ...embeddedNetworkTools,
  ...embeddedCryptoEncodingTools, ...embeddedCryptoPrimitiveTools, ...embeddedCryptoJwtTools,
  embeddedRsaTool, embeddedX509Tool, embeddedRegexTool, embeddedAesTool,
]);

/** Implementations routed by job.submit through the same in-process RPC dispatcher. */
export const embeddedFileToolImplementations = byToolId([
  ...pageTools, ...geometryTools.filter((tool) => tool.id !== 'crop'), ...invoiceTools, embeddedMetadataTool,
  ...embeddedPdfTextExportTools, embeddedPdfToExcelTool, embeddedPdfToEpubTool,
  embeddedOfdToPdfTool, embeddedPdfToPptTool, embeddedPdfToWordTool, embeddedPdfToOfdTool,
  embeddedMarkdownToPdfTool, embeddedCompressTool, embeddedCropTool, ...embeddedConvertTools,
  ...embeddedMarkupTools, embeddedExtractTextTool, embeddedExtractImagesTool, embeddedRepairTool,
  embeddedRemoveBlankTool, ...cryptoEncodingTools.filter((tool) => tool.id === 'file-checksum'),
  ...embeddedDeveloperFileTools, ...embeddedImageTools, ...embeddedOcrTools,
]);
