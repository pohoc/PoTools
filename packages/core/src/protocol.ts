/** Wire protocol shared by the UI, the Node sidecar and the Tauri host. */

export const PROTOCOL_VERSION = 1;

export type ToolId =
  | 'merge'
  | 'split'
  | 'organize'
  | 'rotate'
  | 'extract-pages'
  | 'invoice-merge'
  | 'invoice-organize'
  | 'delete-pages'
  | 'remove-blank'
  | 'resize'
  | 'crop'
  | 'margins'
  | 'nup'
  | 'watermark'
  | 'page-numbers'
  | 'header-footer'
  | 'metadata'
  | 'compress'
  | 'repair'
  | 'pdf-to-images'
  | 'images-to-pdf'
  | 'pdf-to-word'
  | 'pdf-to-excel'
  | 'pdf-to-ppt'
  | 'pdf-to-markdown'
  | 'pdf-to-html'
  | 'pdf-to-csv'
  | 'pdf-to-rtf'
  | 'pdf-to-epub'
  | 'pdf-to-ofd'
  | 'ofd-to-pdf'
  | 'markdown-to-pdf'
  | 'image-compress'
  | 'image-resize'
  | 'image-crop'
  | 'image-rotate'
  | 'image-convert'
  | 'image-info'
  | 'image-cutout'
  | 'image-id-photo'
  | 'image-metadata-clean'
  | 'image-print'
  | 'image-watermark-clean'
  | 'extract-images'
  | 'extract-text'
  | 'timestamp'
  | 'date-diff'
  | 'date-math'
  | 'workdays'
  | 'timezone-board'
  | 'duration'
  | 'cron'
  | 'date-format'
  | 'relative-time'
  | 'hash'
  | 'hmac'
  | 'file-checksum'
  | 'base64'
  | 'radix'
  | 'hex'
  | 'url-codec'
  | 'unicode-escape'
  | 'jwt'
  | 'aes'
  | 'rsa'
  | 'totp'
  | 'x509'
  | 'password-gen'
  | 'uuid-gen';

export type ToolCategory =
  | 'organize'
  | 'convert'
  | 'optimize'
  | 'edit'
  | 'extract'
  | 'metadata';

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export type FileKind =
  | 'pdf'
  | 'image'
  | 'text'
  | 'json'
  | 'docx'
  | 'doc'
  | 'xlsx'
  | 'xls'
  | 'pptx'
  | 'ppt'
  | 'md'
  | 'html'
  | 'csv'
  | 'rtf'
  | 'epub'
  | 'ofd';

/**
 * A file handed to the engine. Native mode carries an absolute `path`;
 * browser dev mode carries `dataBase64` because the page cannot read disk.
 */
export interface FileRef {
  id: string;
  name: string;
  path?: string | null;
  dataBase64?: string;
  sizeBytes?: number;
  mime?: string;
}

export interface OutputFile {
  id: string;
  name: string;
  kind: FileKind;
  path?: string | null;
  /** The engine's staged copy is gone (temp cleanup), so it cannot be re-served. */
  stagedMissing?: boolean;
  dataBase64?: string;
  sizeBytes: number;
  /** 1-based page the artifact came from, when relevant. */
  page?: number;
  sourceFileId?: string;
}

export interface JobOutputRequest {
  /** Absolute directory the engine writes results into. Omit to get base64 back. */
  dir?: string | null;
  /** Also stream bytes back to the caller. */
  wantBytes?: boolean;
}

export interface JobGlobals {
  /** Explicit font file used when an option needs glyphs beyond WinAnsi (CJK). */
  fontPath?: string | null;
  /** Directory the engine may use for scratch files. */
  tempDir?: string | null;
  /** Password for reading protected inputs (empty-password files unlock automatically). */
  password?: string | null;
  locale?: string;
}

export interface JobRequest {
  id: string;
  tool: ToolId;
  files: FileRef[];
  options: Record<string, unknown>;
  output?: JobOutputRequest;
  globals?: JobGlobals;
  /** Naming pattern for artifacts, e.g. `{name}_{range}`. */
  namePattern?: string;
  createdAt?: number;
  label?: string;
}

export interface JobProgress {
  state: JobState;
  percent: number;
  phase?: string;
  messageKey?: string;
  current?: number;
  total?: number;
}

export interface JobError {
  code: string;
  message: string;
  details?: unknown;
}

export interface JobSummary {
  inputBytes: number;
  outputBytes: number;
  pageCountIn: number;
  pageCountOut: number;
  /** Ratio > 1 means the output grew. */
  sizeDeltaPercent?: number;
  extra?: Record<string, number | string>;
}

export interface JobSnapshot {
  id: string;
  tool: ToolId;
  label?: string;
  fileNames: string[];
  createdAt: number;
  finishedAt?: number;
  progress: JobProgress;
  artifacts: OutputFile[];
  summary?: JobSummary;
  warnings: string[];
  error?: JobError;
}

export interface PageThumb {
  page: number;
  dataUrl: string;
  width: number;
  height: number;
  rotation: number;
  label?: string;
}

export interface PageInfo {
  page: number;
  width: number;
  height: number;
  rotation: number;
}

export interface ProbedPdf {
  fileId: string;
  name: string;
  sizeBytes: number;
  pageCount: number;
  pages: PageInfo[];
  metadata: Record<string, string>;
  encrypted: boolean;
  /** MediaBox size of the largest page, used to pick a default canvas. */
  uniformSize: boolean;
}

export interface EngineInfo {
  name: string;
  version: string;
  protocol: number;
  platform: string;
  nodeVersion: string;
  pid: number;
  /** OS-appropriate folder for results, e.g. ~/Documents/PoTools. */
  defaultOutputDir: string;
  /** Scratch folder holding staged inputs and artifacts. */
  tempDir: string;
  /** OS temp folder PoTools would use when no custom path is set. */
  defaultTempDir: string;
  /** Feature flags the UI uses to enable or degrade tools. */
  features: {
    rasterizer: 'mupdf' | 'none';
    imageCodec: boolean;
    cjkFont: string | null;
    busy: boolean;
  };
}

/** One level of the folder tree, for the in-app directory picker. */
export interface DirListing {
  /** Folder actually listed; equals `requested` unless it does not exist yet. */
  path: string;
  /** Path the caller asked for, so a not-yet-created folder stays selectable. */
  requested: string;
  parent: string | null;
  dirs: Array<{ name: string; path: string }>;
  quick: Array<{ id: 'home' | 'documents' | 'downloads' | 'desktop'; path: string }>;
}

export interface TempUsage {
  dir: string;
  jobs: number;
  files: number;
  bytes: number;
  oldestAt: number | null;
  newestAt: number | null;
}

export interface TempCleanResult {
  removedJobs: number;
  removedFiles: number;
  freedBytes: number;
  keptJobs: number;
}

/** Reply of `tool.run`: a text tool executed in memory, nothing written to disk. */
export interface TextRunResult {
  text: string;
  artifacts: Array<{ name: string; kind: FileKind; sizeBytes: number; dataBase64: string }>;
  warnings: string[];
  extra?: Record<string, number | string>;
  ms: number;
}

export type RpcMethodName =
  | 'engine.info'
  | 'engine.ping'
  | 'engine.setTempDir'
  | 'tools.list'
  | 'tool.run'
  | 'job.submit'
  | 'job.cancel'
  | 'job.list'
  | 'job.clear'
  | 'file.probe'
  | 'fs.browse'
  | 'file.bytes'
  | 'page.thumbs'
  | 'page.list'
  | 'file.write'
  | 'shell.reveal'
  | 'shell.print'
  | 'temp.stat'
  | 'temp.clean'
  | 'invoice.scan'
  | 'invoice.archive'
  | 'invoice.undo';

export interface RpcRequest<M extends RpcMethodName = RpcMethodName> {
  jsonrpc: '2.0';
  id: string;
  method: M;
  params: RpcParamsMap[M];
}

export interface RpcParamsMap {
  'engine.info': Record<string, never>;
  'engine.ping': Record<string, never>;
  'engine.setTempDir': { dir: string | null };
  'fs.browse': { path: string | null };
  'tools.list': Record<string, never>;
  'tool.run': { tool: ToolId; options: Record<string, unknown>; globals?: JobGlobals };
  'job.submit': { job: JobRequest };
  'job.cancel': { jobId: string };
  'job.list': Record<string, never>;
  'job.clear': { jobIds?: string[] };
  'file.probe': { file: FileRef };
  'file.bytes': { file: FileRef };
  'page.thumbs': {
    file: FileRef;
    pages: number[];
    width?: number;
    format?: 'png' | 'jpeg';
    quality?: number;
  };
  'page.list': { file: FileRef };
  'file.write': { jobId?: string; artifactId?: string; from?: string; dir?: string; name?: string; dataBase64?: string };
  'shell.reveal': { path: string; open?: boolean };
  'shell.print': { path: string };
  'temp.stat': Record<string, never>;
  'temp.clean': { olderThanDays?: number; keepJobs?: number };
  'invoice.scan': { directory: string; recursive?: boolean; maxFiles?: number; excludeDirectory?: string };
  'invoice.archive': {
    sourceDirectory: string;
    targetDirectory: string;
    conflict: 'rename' | 'skip';
    files: Array<{ path: string; sha256: string; relativePath: string; enabled: boolean; fields?: InvoiceScanEntry['fields'] }>;
  };
  'invoice.undo': { archiveId: string };
}

export interface InvoiceScanEntry {
  path: string;
  relativePath: string;
  name: string;
  extension: string;
  sizeBytes: number;
  sha256: string;
  pageCount: number | null;
  extractedText: string;
  recognition: 'native-text' | 'needs-ocr' | 'failed';
  fields: {
    date: string;
    seller: string;
    buyer: string;
    invoiceNo: string;
    amount: string;
    type: string;
  };
  error?: string;
}

export interface InvoiceScanResult {
  sourceDirectory: string;
  scannedAt: number;
  files: InvoiceScanEntry[];
  skipped: Array<{ relativePath: string; reason: string }>;
  warnings: string[];
}

export interface InvoiceArchiveResult {
  archiveId: string;
  copied: Array<{ source: string; target: string; sha256: string; fields: InvoiceScanEntry['fields'] }>;
  skipped: Array<{ source: string; reason: string }>;
  failed: Array<{ source: string; reason: string }>;
  reportPath?: string;
  csvReportPath?: string;
  warnings: string[];
}

export interface InvoiceUndoResult {
  removed: string[];
  skipped: Array<{ path: string; reason: string }>;
}

export interface RpcSuccess<R> {
  jsonrpc: '2.0';
  id: string;
  result: R;
}

export interface RpcFailure {
  jsonrpc: '2.0';
  id: string;
  error: JobError & { data?: unknown };
}

export type RpcResponse = RpcSuccess<unknown> | RpcFailure;

/** Engine -> UI notifications. */
export type EngineEvent =
  | { event: 'job.updated'; job: JobSnapshot }
  | { event: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string };
