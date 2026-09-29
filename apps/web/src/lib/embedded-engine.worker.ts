import { dispatch as dispatchWasm } from '../../../../packages/engine/wasm/pkg/potools_engine.js';
import type { FileKind, JobRequest, JobSnapshot } from 'core';
import { ensureRustCore } from './rust-core.ts';
import { renderPageThumbs } from './page-thumbs.ts';
import { runPageImagesJob } from './page-images.ts';
import { runOcrJob } from './ocr-recognition.ts';
import { buildConvertRuntimeData, CONVERSION_TOOLS } from './pdf-convert-runtime.ts';
import type { EmbeddedRpcRequest, InMemoryJobResult, ResolvedInput } from './engine-types.ts';

interface RequestMessage {
  id: number;
  rpc?: EmbeddedRpcRequest;
  inputs?: ResolvedInput[];
  runtimeData?: Record<string, unknown>;
  cancelJobId?: string;
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<RequestMessage>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const worker = self as unknown as WorkerScope;
const cancelledJobs = new Set<string>();

interface RustReply {
  handled: boolean;
  result?: {
    text?: string;
    artifacts: Array<{ name: string; kind: string; sizeBytes: number; sourceFileId?: string; bytes: number[] }>;
    warnings: string[];
    extra: Record<string, unknown>;
  };
  error?: { code: string; message: string; hintKey?: string };
}

interface RustPdfRpcReply {
  handled: boolean;
  result?: unknown;
  error?: { code: string; message: string; hintKey?: string };
}

async function ensureRustWasm(): Promise<void> {
  try {
    await ensureRustCore();
  } catch {
    throw new Error('Rust WASM 引擎初始化失败');
  }
}

function rustDispatchRequest(tool: string, options: Record<string, unknown>, locale: string, inputs: ResolvedInput[] = [], namePattern?: string, runtimeData?: Record<string, unknown>) {
  return {
    tool,
    options,
    locale,
    namePattern,
    runtimeData,
    inputs: inputs.map((input) => ({
      id: input.id,
      name: input.name,
      path: input.path ?? null,
      bytes: input.bytes,
    })),
  };
}

async function runRustTextTool(id: number, request: EmbeddedRpcRequest, runtimeData?: Record<string, unknown>): Promise<boolean> {
  await ensureRustWasm();
  const startedAt = performance.now();
  const reply = dispatchWasm({
    tool: request.params.tool,
    options: request.params.options ?? {},
    locale: (request.params.globals as { locale?: string } | undefined)?.locale ?? 'zh-CN',
    namePattern: request.params.namePattern as string | undefined,
    runtimeData,
  }) as RustReply;
  if (reply.error) {
    worker.postMessage({ id, handled: true, error: reply.error });
    return true;
  }
  if (!reply.handled || !reply.result) return false;
  const artifacts = reply.result.artifacts.map((artifact) => {
    const bytes = Uint8Array.from(artifact.bytes);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return { name: artifact.name, kind: artifact.kind, sizeBytes: artifact.sizeBytes, dataBase64: btoa(binary) };
  });
  worker.postMessage({
    id,
    handled: true,
    result: {
      text: reply.result.text ?? '',
      artifacts,
      warnings: reply.result.warnings,
      extra: Object.keys(reply.result.extra).length ? reply.result.extra : undefined,
      ms: Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100),
    },
  });
  return true;
}

async function runRustFileJob(id: number, job: JobRequest, inputs: ResolvedInput[], runtimeData?: Record<string, unknown>, preparePercent = 1): Promise<boolean> {
  await ensureRustWasm();
  const createdAt = job.createdAt ?? Date.now();
  worker.postMessage({
    id,
    progress: {
      id: job.id,
      tool: job.tool,
      label: job.label,
      fileNames: inputs.map((input) => input.name),
      createdAt,
      progress: { state: 'running', percent: preparePercent, phase: 'prepare' },
      artifacts: [],
      warnings: [],
    } satisfies JobSnapshot,
  });
  // dispatchWasm rejects on engine errors (Result::Err). Surface them as a
  // failed job snapshot instead of a bare error reply, which the UI cannot
  // render.
  let reply: RustReply;
  try {
    reply = dispatchWasm(rustDispatchRequest(
      job.tool,
      job.options,
      job.globals?.locale ?? 'zh-CN',
      inputs,
      job.namePattern,
      runtimeData,
    )) as RustReply;
  } catch (issue) {
    const payload = issue as { source?: { message?: string; code?: string } ; message?: string };
    const inner = payload.source ?? payload;
    worker.postMessage({
      id,
      handled: true,
      jobResult: {
        handled: true,
        snapshot: {
          id: job.id,
          tool: job.tool,
          label: job.label,
          fileNames: inputs.map((input) => input.name),
          createdAt,
          finishedAt: Date.now(),
          progress: { state: 'failed', percent: preparePercent },
          artifacts: [],
          warnings: [],
          error: { code: inner.code ?? 'internal', message: inner.message ?? String(issue) },
        },
        artifacts: [],
      },
    });
    return true;
  }
  if (!reply.handled) return false;

  const base = {
    id: job.id,
    tool: job.tool,
    label: job.label,
    fileNames: inputs.map((input) => input.name),
    createdAt,
    artifacts: [],
    warnings: reply.result?.warnings ?? [],
  };
  if (reply.error) {
    const snapshot: JobSnapshot = {
      ...base,
      finishedAt: Date.now(),
      progress: { state: 'failed', percent: 1 },
      error: { code: reply.error.code, message: reply.error.message },
    };
    worker.postMessage({ id, handled: true, jobResult: { handled: true, snapshot, artifacts: [] } });
    return true;
  }
  if (!reply.result) return false;

  const artifacts = reply.result.artifacts.map((artifact, index) => ({
    id: String(index + 1),
    name: artifact.name,
    kind: artifact.kind as FileKind,
    bytes: Uint8Array.from(artifact.bytes),
    sourceFileId: artifact.sourceFileId,
  }));
  const inputBytes = inputs.reduce((sum, input) => sum + input.bytes.byteLength, 0);
  const outputBytes = artifacts.reduce((sum, artifact) => sum + artifact.bytes.byteLength, 0);
  const rawExtra = { ...reply.result.extra };
  const pageCountIn = typeof rawExtra.__pageCountIn === 'number' ? rawExtra.__pageCountIn : 0;
  const pageCountOut = typeof rawExtra.__pageCountOut === 'number' ? rawExtra.__pageCountOut : artifacts.length;
  delete rawExtra.__pageCountIn;
  delete rawExtra.__pageCountOut;
  const extra = Object.fromEntries(Object.entries(rawExtra)
    .filter(([, value]) => typeof value === 'string' || typeof value === 'number')) as Record<string, string | number>;
  const snapshot: JobSnapshot = {
    ...base,
    artifacts: artifacts.map((artifact) => ({
      id: artifact.id,
      name: artifact.name,
      kind: artifact.kind,
      path: null,
      sizeBytes: artifact.bytes.byteLength,
      sourceFileId: artifact.sourceFileId,
    })),
    finishedAt: Date.now(),
    progress: { state: 'succeeded', percent: 100, phase: 'done' },
    summary: {
      inputBytes,
      outputBytes,
      pageCountIn,
      pageCountOut,
      sizeDeltaPercent: inputBytes > 0 ? Math.round(((outputBytes - inputBytes) / inputBytes) * 100) : 0,
      extra: Object.keys(extra).length ? extra : undefined,
    },
  };
  const jobResult: InMemoryJobResult = { handled: true, snapshot, artifacts };
  worker.postMessage(
    { id, handled: true, jobResult },
    artifacts.map((artifact) => artifact.bytes.buffer as ArrayBuffer),
  );
  return true;
}

/**
 * Browser adapter for conversion tools: builds the PDF.js runtimeData the
 * Rust runners consume (text runs, region crops, full-page renders, OCR
 * fallback text) through PDF.js + the shared PaddleOCR model, merges it over
 * the host-provided runtimeData (fonts/assets), then dispatches to Rust.
 * Preparation failures (encrypted/unreadable documents) fail the job with
 * the same codes the established adapters use.
 */
async function runConversionJob(id: number, job: JobRequest, inputs: ResolvedInput[], hostData: Record<string, unknown> | undefined): Promise<boolean> {
  if (!CONVERSION_TOOLS.has(job.tool)) return false;
  const base = {
    id: job.id,
    tool: job.tool,
    label: job.label,
    fileNames: inputs.map((input) => input.name),
    createdAt: job.createdAt ?? Date.now(),
  };
  let runtimeData = hostData;
  let lastPercent = 1;
  try {
    const built = await buildConvertRuntimeData(job, inputs, (percent, phase) => {
      lastPercent = Math.max(lastPercent, percent);
      worker.postMessage({
        id,
        progress: { ...base, artifacts: [], warnings: [], progress: { state: 'running', percent, phase } } satisfies JobSnapshot,
      });
    });
    if (built) runtimeData = { ...(hostData ?? {}), ...built };
  } catch (error) {
    const issue = error as Error & { code?: string };
    const snapshot: JobSnapshot = {
      ...base,
      artifacts: [],
      warnings: [],
      finishedAt: Date.now(),
      progress: { state: 'failed', percent: 1 },
      error: { code: issue.code ?? 'unreadable_file', message: issue.message || String(error) },
    };
    worker.postMessage({ id, handled: true, jobResult: { handled: true, snapshot, artifacts: [] } });
    return true;
  }
  return runRustFileJob(id, job, inputs, runtimeData, lastPercent);
}

/** Browser adapter fallback for tools the Rust engine does not handle (e.g. `pdf-to-images`). */
async function runPageImagesJobRpc(id: number, job: JobRequest, inputs: ResolvedInput[]): Promise<boolean> {
  if (job.tool !== 'pdf-to-images') return false;
  await ensureRustWasm();
  const reply = await runPageImagesJob(job, inputs, (snapshot) => worker.postMessage({ id, progress: snapshot }));
  if (!reply.handled || !reply.snapshot) return false;
  const artifacts = reply.artifacts ?? [];
  worker.postMessage(
    { id, handled: true, jobResult: { handled: true, snapshot: reply.snapshot, artifacts } },
    artifacts.map((artifact) => artifact.bytes.buffer as ArrayBuffer),
  );
  return true;
}

/**
 * Browser adapter for OCR tools: pixels decode in the browser (PDF.js or the
 * Rust image decoder), PaddleOCR runs on the shared model, and the Rust engine
 * assembles the text/xlsx artifacts.
 */
async function runOcrJobRpc(id: number, job: JobRequest, inputs: ResolvedInput[]): Promise<boolean> {
  if (job.tool !== 'ocr-text' && job.tool !== 'ocr-table') return false;
  await ensureRustWasm();
  const reply = await runOcrJob(job, inputs, (snapshot) => worker.postMessage({ id, progress: snapshot }));
  if (!reply) return false;
  const artifacts = reply.artifacts ?? [];
  worker.postMessage(
    { id, handled: true, jobResult: { handled: true, snapshot: reply.snapshot, artifacts } },
    artifacts.map((artifact) => artifact.bytes.buffer as ArrayBuffer),
  );
  return true;
}

async function runRustPdfRpc(id: number, request: EmbeddedRpcRequest, inputs: ResolvedInput[] = []): Promise<boolean> {
  if (request.method !== 'file.probe' && request.method !== 'page.list') return false;
  const file = request.params.file as { id?: string; name?: string } | undefined;
  const input = inputs.find((item) => item.id === file?.id) ?? inputs[0];
  if (!file || !input) return false;
  await ensureRustWasm();
  const reply = dispatchWasm(rustDispatchRequest(request.method, {}, 'zh-CN', [input])) as RustPdfRpcReply;
  if (!reply.handled) return false;
  if (reply.error) {
    worker.postMessage({ id, handled: true, error: reply.error });
  } else {
    worker.postMessage({ id, handled: true, result: reply.result });
  }
  return true;
}

async function runPageThumbsRpc(id: number, request: EmbeddedRpcRequest, inputs: ResolvedInput[] = []): Promise<boolean> {
  if (request.method !== 'page.thumbs') return false;
  const reply = await renderPageThumbs(inputs, request.params);
  worker.postMessage({ id, ...reply });
  return true;
}

worker.onmessage = async ({ data }) => {
  try {
    if (data.cancelJobId) {
      cancelledJobs.add(data.cancelJobId);
      return;
    }
    if (!data.rpc) throw new Error('缺少内嵌 RPC 请求');
    if (await runPageThumbsRpc(data.id, data.rpc, data.inputs)) return;
    if (await runRustPdfRpc(data.id, data.rpc, data.inputs)) return;
    if (data.rpc.method === 'tool.run' && await runRustTextTool(data.id, data.rpc, data.runtimeData)) return;
    if (data.rpc.method === 'job.submit') {
      const request = data.rpc.params.job as JobRequest | undefined;
      if (request && data.inputs) {
        if (await runConversionJob(data.id, request, data.inputs, data.runtimeData)) return;
        if (await runRustFileJob(data.id, request, data.inputs, data.runtimeData)) return;
        if (await runPageImagesJobRpc(data.id, request, data.inputs)) return;
        if (await runOcrJobRpc(data.id, request, data.inputs)) return;
        worker.postMessage({ id: data.id, handled: false });
        return;
      }
    }
    worker.postMessage({ id: data.id, handled: false });
  } catch (error) {
    const issue = error as Error & { code?: string; hintKey?: string };
    worker.postMessage({
      id: data.id,
      handled: true,
      error: {
        code: issue.code ?? 'internal',
        message: issue.message || String(error),
        hintKey: issue.hintKey,
      },
    });
  }
};
