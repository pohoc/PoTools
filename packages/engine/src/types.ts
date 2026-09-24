import type { FileKind, JobGlobals, JobOutputRequest, JobSummary, OutputFile, ToolId } from '@potools/core';
import type { PDFDocument } from 'pdf-lib';

export interface ResolvedInput {
  id: string;
  name: string;
  path: string | null;
  bytes: Uint8Array;
}

export interface Progress {
  percent: number;
  phase?: string;
  current?: number;
  total?: number;
}

export interface ArtifactDraft {
  name: string;
  kind: FileKind;
  bytes: Uint8Array;
  page?: number;
  sourceFileId?: string;
}

export interface ToolContext {
  inputs: ResolvedInput[];
  /** Host-provided PDF loader; lets the same tools run from disk or in-memory bytes. */
  loadPdf(input: ResolvedInput, globals?: JobGlobals): Promise<PDFDocument>;
  /** Optional native raster analysis service; browser jobs route such requests to the host. */
  contentInsets?(bytes: Uint8Array, page: number, globals: JobGlobals, rotation?: number): Promise<{ top: number; right: number; bottom: number; left: number } | null>;
  options: Record<string, string | number | boolean>;
  globals: JobGlobals;
  /** Optional services/results supplied by a privileged desktop host. */
  runtimeData?: Record<string, unknown>;
  output?: JobOutputRequest;
  namePattern?: string;
  warnings: string[];
  report(progress: Progress): void;
  cancelled(): boolean;
  emit(artifact: ArtifactDraft): Promise<void>;
  /** Convenience for the common single-PDF-result case. */
  emitPdf(name: string, bytes: Uint8Array, sourceFileId?: string): Promise<void>;
}

export interface ToolResult {
  extra?: Record<string, number | string>;
  pageCountIn?: number;
  pageCountOut?: number;
}

export interface ToolImpl {
  id: ToolId;
  run(ctx: ToolContext): Promise<ToolResult | void>;
}

export type SummaryPart = Partial<Pick<JobSummary, 'pageCountIn' | 'pageCountOut' | 'extra'>>;
