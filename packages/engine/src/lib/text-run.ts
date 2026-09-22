import { Buffer } from 'node:buffer';
import { performance } from 'node:perf_hooks';
import type { FileKind, JobGlobals, TextRunResult, ToolId } from '@potools/core';
import { TOOLS } from '@potools/core';
import { EngineError } from '../errors.ts';
import { TOOL_IMPL_MAP } from '../tools/index.ts';
import { makeMsg } from './messages.ts';
import { coerceOptions } from './options.ts';
import type { ArtifactDraft, Progress, ToolContext } from '../types.ts';

export interface TextRunRequest {
  tool: ToolId;
  options?: Record<string, unknown>;
  globals?: JobGlobals;
}

/**
 * Text tools answer with bytes the caller copies or saves itself, so nothing here
 * touches the filesystem: no job record, no temp dir, no progress events.
 */
export async function runTextTool(request: TextRunRequest): Promise<TextRunResult> {
  const msg = makeMsg(request.globals?.locale);
  const descriptor = TOOLS[request.tool];
  if (!descriptor) throw new EngineError('unknown_tool', msg('common.error.unknownTool', { tool: request.tool }));
  if (descriptor.layout !== 'text') {
    throw new EngineError('unsupported', msg('common.error.notTextTool', { tool: request.tool }));
  }
  if (descriptor.requiresInput === true) {
    throw new EngineError('unsupported', msg('common.error.needsFileInput', { tool: request.tool }));
  }
  const impl = TOOL_IMPL_MAP[request.tool];
  if (!impl) throw new EngineError('unknown_tool', msg('common.error.notImplemented', { tool: request.tool }));

  const started = performance.now();
  const drafts: ArtifactDraft[] = [];
  const warnings: string[] = [];
  const ctx = {
    inputs: [],
    globals: request.globals ?? {},
    warnings,
    options: coerceOptions(descriptor, request.options),
    cancelled: () => false,
    report: (_progress: Progress) => {},
    emit: async (draft: ArtifactDraft) => {
      drafts.push(draft);
    },
    emitPdf: (name: string, bytes: Uint8Array, sourceFileId?: string) =>
      ctx.emit({ name, kind: 'pdf' as FileKind, bytes, sourceFileId }),
  };

  const result = await impl.run(ctx as never);
  const ms = Math.max(0, Math.round((performance.now() - started) * 100) / 100);

  const artifacts = drafts.map((draft) => ({
    name: draft.name,
    kind: draft.kind as FileKind,
    sizeBytes: draft.bytes.byteLength,
    dataBase64: Buffer.from(draft.bytes).toString('base64'),
  }));
  const textDraft = drafts.find((draft) => draft.kind === 'text' || draft.kind === 'json');
  const extra = result?.extra;

  return {
    text: textDraft ? new TextDecoder().decode(textDraft.bytes) : '',
    artifacts,
    warnings,
    extra: extra && Object.keys(extra).length ? extra : undefined,
    ms,
  };
}
