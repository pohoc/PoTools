import { archivePlugin, imagePlugin, ofdPlugin, officePlugin, pdfPlugin, textPlugin } from '@open-file-viewer/core';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import '@open-file-viewer/core/style.css';

/** One shared plugin set for every FileViewer instance (input previews and
 *  output artifacts alike), so two dialogs never build two plugin runtimes.
 *  OFD is a catalog input format and archives cover the zip-artifact tools;
 *  everything unmatched falls back to the viewer's metadata card. */
export const FILE_VIEWER_PLUGINS = [
  imagePlugin(),
  pdfPlugin({ workerSrc: pdfWorkerUrl }),
  officePlugin(),
  ofdPlugin(),
  textPlugin(),
  archivePlugin(),
];

const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  json: 'application/json',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  html: 'text/html',
  xml: 'application/xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  heic: 'image/heic',
};

/** The viewer sniffs bytes where it can, but an honest mime keeps format
 *  detection from guessing on extensionless or mislabeled buffers. */
export function fileViewerSource(bytes: ArrayBuffer | Uint8Array, name: string): File {
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  const part = bytes instanceof Uint8Array ? (bytes.slice().buffer as ArrayBuffer) : bytes;
  return new File([part], name, { type: MIME_BY_EXTENSION[extension] ?? 'application/octet-stream' });
}
