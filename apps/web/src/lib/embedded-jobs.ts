import type { EngineInfo, FileKind, FileRef, JobRequest, JobSnapshot } from 'core';
import type { ResolvedInput } from './engine-types.ts';
import { callEmbeddedRpc, cancelEmbeddedFileJob } from './embedded-engine.ts';
import { contentInsetsRuntimeData, removeBlankInkRuntimeData } from './pdf-content-insets.ts';
import { markupNeedsUnicodeFont, markdownRuntimeData, ofdRuntimeData, systemFontRuntimeData } from './file-runtime-data.ts';
import { engineBridge, isTauri } from './tauri.ts';
import {
  decodeBase64,
  encodeBase64,
  encodeMarkupFontRuntimeData,
  optionTruthy,
  RpcError,
  RUST_NATIVE_FILE_TOOLS,
} from './transport-shared.ts';

/** Dependencies the embedded job runner needs from the owning transport. */
export interface EmbeddedJobHost {
  resolveInput(file: FileRef): Promise<ResolvedInput>;
  /** Publishes a job snapshot event; the runner already updated its own map. */
  publish(snapshot: JobSnapshot): void;
  tempDir(): string | null;
  defaultTempDir(): string | null;
  ensureRuntime(): Promise<EngineInfo>;
}

/** Browser/network precomputation for text tools dispatched through tool.run. */
export async function textToolRuntimeData(tool: string, options: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  let runtimeData: Record<string, unknown> | undefined;
  if (tool === 'ip-lookup') {
    const ip = String(options.ip ?? '').trim();
    const endpoint = new URL('https://ip.bt.cn/ip_api.php');
    if (ip) endpoint.searchParams.set('ip', ip);
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) {
        runtimeData = { ipLookup: { status: 'network' } };
      } else {
        try {
          runtimeData = { ipLookup: { status: 'ok', payload: await response.json() } };
        } catch {
          runtimeData = { ipLookup: { status: 'response' } };
        }
      }
    } catch {
      runtimeData = { ipLookup: { status: 'network' } };
    }
  }
  if (tool === 'dns-lookup' && !isTauri()) {
    const hostname = String(options.hostname ?? '').replace(/\.$/, '').toLowerCase();
    const recordType = String(options.recordType ?? '').toUpperCase();
    const typeCode: Record<string, number> = { A: 1, NS: 2, CNAME: 5, SOA: 6, MX: 15, TXT: 16, AAAA: 28 };
    let records: string[] = [];
    if (typeCode[recordType]) {
      const endpoint = new URL('https://dns.google/resolve');
      endpoint.searchParams.set('name', hostname);
      endpoint.searchParams.set('type', recordType);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2500);
      try {
        const response = await fetch(endpoint, { headers: { accept: 'application/dns-json' }, signal: controller.signal });
        if (response.ok) {
          const payload = await response.json() as { Status?: number; Answer?: Array<{ type?: number; data?: string }> };
          if (payload.Status === 0 && Array.isArray(payload.Answer)) {
            records = payload.Answer
              .filter((answer) => answer.type === typeCode[recordType] && typeof answer.data === 'string')
              .map((answer) => answer.data!);
          }
        }
      } catch {
        records = [];
      } finally {
        clearTimeout(timeout);
      }
    }
    runtimeData = { ...runtimeData, nativeDns: { hostname, recordType, records } };
  }
  return runtimeData;
}

/** Runs one queued file job: precomputes runtimeData, then native or worker dispatch. */
export class EmbeddedJobRunner {
  private jobs = new Map<string, JobSnapshot>();
  private artifactPaths = new Map<string, string>();
  private artifactRoots = new Map<string, string>();
  private queue: Array<{ request: JobRequest; inputs: ResolvedInput[] }> = [];
  private active = 0;
  private concurrency = 1;

  constructor(private readonly host: EmbeddedJobHost) {}

  configure(concurrency?: number): void {
    this.concurrency = Math.max(1, Math.min(4, Math.trunc(concurrency ?? 1)));
  }

  get size(): number {
    return this.concurrency;
  }

  list(): JobSnapshot[] {
    return [...this.jobs.values()];
  }

  async submit<T>(request: JobRequest): Promise<T> {
    let inputs: ResolvedInput[];
    let failedInput: { file: FileRef; error: unknown } | undefined;
    try {
      inputs = await Promise.all((request.files ?? []).map(async (file: FileRef) => {
        try {
          return await this.host.resolveInput(file);
        } catch (error) {
          failedInput ??= { file, error };
          throw error;
        }
      }));
    } catch (error) {
      return this.publishInputFailure<T>(request, failedInput?.file, failedInput?.error ?? error);
    }

    if (!isTauri()) request.output = { ...request.output, dir: null, wantBytes: true };
    const snapshot: JobSnapshot = {
      id: request.id,
      tool: request.tool,
      label: request.label,
      fileNames: inputs.map((input) => input.name),
      createdAt: request.createdAt ?? Date.now(),
      progress: { state: 'queued', percent: 0 },
      artifacts: [],
      warnings: [],
    };
    this.jobs.set(request.id, snapshot);
    this.queue.push({ request, inputs });
    this.pump();
    return snapshot as T;
  }

  async cancel(jobId: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job || !['queued', 'running'].includes(job.progress.state)) return false;
    const queuedIndex = this.queue.findIndex((entry) => entry.request.id === jobId);
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
    } else {
      cancelEmbeddedFileJob(jobId);
    }
    this.publish({
      ...job,
      finishedAt: Date.now(),
      progress: { state: 'cancelled', percent: 0 },
    });
    return true;
  }

  clear(jobIds?: string[]): number {
    const ids = jobIds ?? [...this.jobs.keys()];
    return ids.filter((id) => {
      const job = this.jobs.get(id);
      if (!job || !['succeeded', 'failed', 'cancelled'].includes(job.progress.state)) return false;
      this.jobs.delete(id);
      for (const artifact of job.artifacts) {
        this.artifactPaths.delete(`${id}:${artifact.id}`);
        this.artifactRoots.delete(`${id}:${artifact.id}`);
      }
      return true;
    }).length;
  }

  /** Copies a staged artifact into the requested output directory. */
  async stagedOutput<T>(jobId: string, artifactId: string, dir: string, name: string): Promise<T | undefined> {
    const artifactKey = `${jobId}:${artifactId}`;
    const staged = this.artifactPaths.get(artifactKey);
    const tempRoot = this.artifactRoots.get(artifactKey);
    if (!staged) return undefined;
    const bridge = await engineBridge();
    const path = await bridge.invoke<string>('copy_staged_artifact', {
      from: staged,
      dir,
      name,
      tempRoot: tempRoot ?? this.host.tempDir() ?? this.host.defaultTempDir() ?? '',
    });
    return { path, name: path.split(/[\\/]/).pop() } as T;
  }

  private publishInputFailure<T>(request: JobRequest, file: FileRef | undefined, error: unknown): T {
    const now = Date.now();
    if (!isTauri()) request.output = { ...request.output, dir: null, wantBytes: true };
    const snapshot: JobSnapshot = {
      id: request.id,
      tool: request.tool,
      label: request.label,
      fileNames: (request.files ?? []).map((item) => item.name),
      createdAt: request.createdAt ?? now,
      progress: { state: 'queued', percent: 0 },
      artifacts: [],
      warnings: [],
    };
    this.publish(snapshot);
    snapshot.progress = { state: 'running', percent: 1, phase: 'prepare' };
    this.publish(snapshot);

    const detail = error instanceof Error ? error.message : String(error);
    const missing = /ENOENT|os error 2|no such file|cannot find (?:the )?file/i.test(detail);
    const hasPath = Boolean(file?.path);
    snapshot.error = {
      code: hasPath ? 'unreadable_file' : error instanceof RpcError ? error.code : 'bad_request',
      message: !file
        ? detail
        : missing
          ? `${file.name || file.path} 已不存在，可能已被移动、删除或清理`
          : hasPath
            ? `无法读取 ${file.name || file.path}: ${detail}`
            : detail,
    };
    snapshot.finishedAt = Date.now();
    snapshot.progress = { state: 'failed', percent: 1 };
    this.publish(snapshot);
    return snapshot as T;
  }

  private pump(): void {
    while (this.active < this.concurrency && this.queue.length) {
      const queued = this.queue.shift();
      if (!queued) break;
      this.active += 1;
      void this.runEmbeddedJob(queued.request, queued.inputs).finally(() => {
        this.active -= 1;
        this.pump();
      });
    }
  }

  private async runEmbeddedJob(request: JobRequest, inputs: ResolvedInput[]): Promise<void> {
    try {
      let embedded: Awaited<ReturnType<typeof callEmbeddedRpc>> | undefined;
      const autoCrop = request.options.autoCrop !== false
        && request.options.autoCrop !== 'false'
        && request.options.autoCrop !== 0
        && request.options.autoCrop !== '0';
      const shrinkToContent = optionTruthy(request.options.shrinkToContent);
      const contentInsetsData = (request.tool === 'invoice-merge' && autoCrop)
        || (request.tool === 'crop' && shrinkToContent)
        ? await contentInsetsRuntimeData(inputs, request.globals?.password)
        : undefined;
      const removeBlankData = request.tool === 'remove-blank'
        ? await removeBlankInkRuntimeData(inputs, request.globals?.password)
        : undefined;
      const markupData = ['watermark', 'page-numbers', 'header-footer'].includes(request.tool)
        && markupNeedsUnicodeFont(request, inputs)
        ? encodeMarkupFontRuntimeData(await systemFontRuntimeData(request.globals?.fontPath))
        : undefined;
      const runtimeData = contentInsetsData
        ?? removeBlankData
        ?? markupData
        ?? (request.tool === 'markdown-to-pdf'
          ? await markdownRuntimeData(request, inputs)
          : request.tool === 'pdf-to-ofd' && String(request.options.mode ?? 'text') === 'text'
            ? await ofdRuntimeData(request)
            : undefined);
      if (isTauri() && RUST_NATIVE_FILE_TOOLS.has(request.tool)) {
        const bridge = await engineBridge();
        const native = await bridge.invoke<{
          handled: boolean;
          result?: {
            text: string;
            artifacts: Array<{ name: string; kind: string; sizeBytes: number; sourceFileId?: string; dataBase64: string }>;
            warnings: string[];
            extra?: Record<string, unknown>;
          } | null;
          error?: { code?: string; message?: string; hintKey?: string } | null;
        }>('engine_run_file_tool', {
          tool: request.tool,
          options: request.options,
          locale: request.globals?.locale ?? 'zh-CN',
          namePattern: request.namePattern,
          runtimeData,
          inputs: inputs.map((input) => ({
            id: input.id,
            name: input.name,
            path: input.path,
            dataBase64: encodeBase64(input.bytes),
          })),
        });
        if (native.error) {
          throw new RpcError(native.error.code ?? 'internal', native.error.message ?? 'Rust 引擎执行失败', native.error.hintKey);
        }
        if (native.handled && native.result) {
          const outputArtifacts = native.result.artifacts.map((artifact, index) => ({
            id: String(index + 1),
            name: artifact.name,
            kind: artifact.kind as FileKind,
            bytes: decodeBase64(artifact.dataBase64),
            sourceFileId: artifact.sourceFileId,
          }));
          const outputBytes = outputArtifacts.reduce((sum, artifact) => sum + artifact.bytes.byteLength, 0);
          const inputBytes = inputs.reduce((sum, input) => sum + input.bytes.byteLength, 0);
          const rawExtra = native.result.extra ?? {};
          const pageCountIn = typeof rawExtra.__pageCountIn === 'number' ? rawExtra.__pageCountIn : 0;
          const pageCountOut = typeof rawExtra.__pageCountOut === 'number' ? rawExtra.__pageCountOut : outputArtifacts.length;
          const extra = Object.fromEntries(Object.entries(rawExtra)
            .filter(([key, value]) => key !== '__pageCountIn' && key !== '__pageCountOut'
              && (typeof value === 'string' || typeof value === 'number'))) as Record<string, string | number>;
          const snapshot: JobSnapshot = {
            id: request.id,
            tool: request.tool,
            label: request.label,
            fileNames: inputs.map((input) => input.name),
            createdAt: request.createdAt ?? Date.now(),
            finishedAt: Date.now(),
            progress: { state: 'succeeded', percent: 100, phase: 'done' },
            artifacts: outputArtifacts.map((artifact) => ({
              id: artifact.id,
              name: artifact.name,
              kind: artifact.kind,
              path: null,
              sizeBytes: artifact.bytes.byteLength,
              sourceFileId: artifact.sourceFileId,
            })),
            summary: {
              inputBytes,
              outputBytes,
              pageCountIn,
              pageCountOut,
              sizeDeltaPercent: inputBytes > 0 ? Math.round(((outputBytes - inputBytes) / inputBytes) * 100) : 0,
              extra: Object.keys(extra).length ? extra : undefined,
            },
            warnings: native.result.warnings,
          };
          embedded = { handled: true, jobResult: { handled: true, snapshot, artifacts: outputArtifacts } };
        } else if (native.handled) {
          throw new RpcError('internal', 'Rust 引擎未返回任务结果');
        }
      }
      if (!embedded) {
        embedded = await callEmbeddedRpc('job.submit', { job: request }, {
          inputs,
          runtimeData,
          onProgress: (progress) => {
            if (progress.progress.state === 'running') this.publish(progress);
          },
        });
      }
      if (!embedded.handled) {
        // No sidecar fallback: the tool cannot run on this input in the
        // worker, so the job fails with the established unsupported contract.
        const current = this.jobs.get(request.id);
        if (current) {
          this.publish({
            ...current,
            finishedAt: Date.now(),
            progress: { state: 'failed', percent: current.progress.percent },
            error: { code: 'unsupported', message: '该输入在当前内置引擎下不受支持，请更新 PoTools' },
          });
        }
        this.jobs.delete(request.id);
        return;
      }
      const result = embedded.jobResult;
      if (!result?.snapshot) return;
      const final = result.snapshot;
      if (final.progress.state === 'succeeded') {
        // Browser mode keeps artifacts in memory (download/另存为 fall back
        // to bytes); staging to the temp dir needs the Tauri bridge.
        const artifacts = result.artifacts ?? [];
        if (isTauri()) {
        const bridge = await engineBridge();
        const runtime = await this.host.ensureRuntime();
        const tempRoot = this.host.tempDir() ?? runtime.defaultTempDir;
        for (let index = 0; index < artifacts.length; index += 1) {
          const artifact = artifacts[index];
          const snapshotArtifact = final.artifacts[index];
          if (!artifact || !snapshotArtifact) continue;
          const bytes = artifact.bytes.slice().buffer as ArrayBuffer;
          const staged = await bridge.invoke<{ stagedPath: string; outputPath?: string; name: string }>(
            'stage_job_artifact_binary',
            bytes,
            {
              headers: {
                'x-potools-job-id': request.id,
                'x-potools-name': artifact.name,
                'x-potools-output-dir': request.output?.dir ?? '',
                'x-potools-temp-root': tempRoot,
              },
            },
          );
          snapshotArtifact.name = staged.name;
          snapshotArtifact.path = staged.outputPath ?? staged.stagedPath;
          this.artifactPaths.set(`${request.id}:${snapshotArtifact.id}`, staged.stagedPath);
          this.artifactRoots.set(`${request.id}:${snapshotArtifact.id}`, tempRoot);
        }
        } else {
          // Browser mode: keep bytes with the snapshot so 下载 and previews
          // work without the Tauri bridge.
          for (let index = 0; index < artifacts.length; index += 1) {
            const snapshotArtifact = final.artifacts[index];
            const artifact = artifacts[index];
            if (!artifact || !snapshotArtifact) continue;
            snapshotArtifact.dataBase64 = encodeBase64(artifact.bytes);
          }
        }
      }
      this.publish(final);
    } catch (error) {
      const current = this.jobs.get(request.id);
      if (!current || current.progress.state === 'cancelled') return;
      const issue = error as Error & { code?: string; hintKey?: string };
      const failed: JobSnapshot = {
        ...current,
        finishedAt: Date.now(),
        progress: { state: 'failed', percent: current.progress.percent },
        error: {
          code: issue.code ?? 'internal',
          message: issue.message || String(error),
          details: issue.hintKey ? { hintKey: issue.hintKey } : undefined,
        },
      };
      this.publish(failed);
    }
  }

  private publish(snapshot: JobSnapshot): void {
    this.jobs.set(snapshot.id, snapshot);
    this.host.publish(snapshot);
  }
}
