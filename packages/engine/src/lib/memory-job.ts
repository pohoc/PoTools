import type { FileKind, JobRequest, JobSnapshot, ToolId } from '@potools/core';
import { TOOLS } from '@potools/core';
import { EngineError, toJobError } from '../errors.ts';
import { loadDocument } from './pdf.ts';
import { coerceOptions } from './options.ts';
import { dedupe } from './naming.ts';
import { browserContentInsets } from '../tools/crop-browser.ts';
import { normalizePdfBytes } from './render.ts';
import type { ArtifactDraft, Progress, ResolvedInput, ToolImpl } from '../types.ts';

export class InMemoryFallback extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InMemoryFallback';
  }
}

export interface MemoryArtifact extends Omit<ArtifactDraft, 'bytes'> {
  id: string;
  bytes: Uint8Array;
}

export interface InMemoryJobResult {
  handled: boolean;
  snapshot?: JobSnapshot;
  artifacts?: MemoryArtifact[];
}

/** Runs file tools against bytes supplied by the host; this module never opens paths or writes files. */
export async function runInMemoryJob(
  request: JobRequest,
  inputs: ResolvedInput[],
  implementations: Partial<Record<ToolId, ToolImpl>>,
  onUpdate: (snapshot: JobSnapshot) => void = () => {},
  isCancelled: () => boolean = () => false,
  runtimeData?: Record<string, unknown>,
): Promise<InMemoryJobResult> {
  const descriptor = TOOLS[request.tool];
  if (!descriptor || descriptor.layout === 'text') return { handled: false };
  const tool = implementations[request.tool];
  if (!tool) return { handled: false };
  if (descriptor.requiresInput !== false && !inputs.length) {
    throw new EngineError('bad_request', '请先添加文件');
  }

  const snapshot: JobSnapshot = {
    id: request.id,
    tool: request.tool,
    label: request.label,
    fileNames: inputs.map((input) => input.name),
    createdAt: request.createdAt ?? Date.now(),
    progress: { state: 'running', percent: 1, phase: 'prepare' },
    artifacts: [],
    warnings: [],
  };
  const drafts: ArtifactDraft[] = [];
  const warnings: string[] = [];
  const started = performance.now();
  let lastEmit = 0;
  const publish = () => onUpdate({ ...snapshot, fileNames: [...snapshot.fileNames], artifacts: [...snapshot.artifacts], warnings: [...snapshot.warnings] });
  publish();

  try {
    const context = {
      inputs,
      globals: request.globals ?? {},
      runtimeData,
      output: request.output,
      namePattern: request.namePattern,
      warnings,
      options: coerceOptions(descriptor, request.options),
      cancelled: isCancelled,
      report: (progress: Progress) => {
        const now = Date.now();
        if (now - lastEmit < 120 && progress.percent < 100) return;
        lastEmit = now;
        snapshot.progress = { state: 'running', ...progress };
        publish();
      },
      loadPdf: async (input: ResolvedInput, globals = request.globals ?? {}) => {
        try {
          return await loadDocument(input.bytes, input.name);
        } catch (error) {
          const original = error instanceof Error ? error.message : String(error);
          if (error instanceof EngineError && error.code === 'encrypted_document' && !globals.password) {
            throw new InMemoryFallback(original);
          }
          try {
            const normalized = await normalizePdfBytes(input.bytes, input.name, globals.password);
            return await loadDocument(normalized, input.name);
          } catch {
            throw new InMemoryFallback(original);
          }
        }
      },
      contentInsets: (bytes: Uint8Array, page: number, globals: import('@potools/core').JobGlobals, rotation = 0) =>
        browserContentInsets(bytes, page, globals.password, rotation),
      emit: async (draft: ArtifactDraft) => { drafts.push(draft); },
      emitPdf: async (name: string, bytes: Uint8Array, sourceFileId?: string) => {
        drafts.push({ name, kind: 'pdf', bytes, sourceFileId });
      },
    };
    const result = await tool.run(context as never);
    if (isCancelled()) throw new EngineError('cancelled', '已取消');
    const artifacts: MemoryArtifact[] = [];
    for (const draft of drafts) {
      const name = dedupe(draft.name, new Set(artifacts.map((artifact) => artifact.name)));
      const id = String(artifacts.length + 1);
      artifacts.push({ ...draft, id, name });
      snapshot.artifacts.push({
        id,
        name,
        kind: draft.kind as FileKind,
        path: null,
        sizeBytes: draft.bytes.byteLength,
        page: draft.page,
        sourceFileId: draft.sourceFileId,
      });
    }
    const inputBytes = inputs.reduce((sum, input) => sum + input.bytes.byteLength, 0);
    const outputBytes = artifacts.reduce((sum, artifact) => sum + artifact.bytes.byteLength, 0);
    snapshot.summary = {
      inputBytes,
      outputBytes,
      pageCountIn: result?.pageCountIn ?? 0,
      pageCountOut: result?.pageCountOut ?? artifacts.length,
      sizeDeltaPercent: inputBytes > 0 ? Math.round(((outputBytes - inputBytes) / inputBytes) * 100) : 0,
      extra: result?.extra && Object.keys(result.extra).length ? result.extra : undefined,
    };
    snapshot.warnings = warnings;
    snapshot.finishedAt = Date.now();
    snapshot.progress = { state: 'succeeded', percent: 100, phase: 'done' };
    publish();
    return { handled: true, snapshot, artifacts };
  } catch (error) {
    if (error instanceof InMemoryFallback) return { handled: false };
    const issue = toJobError(error);
    snapshot.finishedAt = Date.now();
    if (issue.code === 'cancelled') snapshot.progress = { state: 'cancelled', percent: 0 };
    else {
      snapshot.error = issue;
      snapshot.progress = { state: 'failed', percent: snapshot.progress.percent };
    }
    snapshot.warnings = warnings;
    publish();
    return { handled: true, snapshot };
  }
}
