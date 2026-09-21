import type { FileKind, JobGlobals, JobOutputRequest, JobSummary, OutputFile, ToolId } from '@potools/core';

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
  options: Record<string, string | number | boolean>;
  globals: JobGlobals;
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
