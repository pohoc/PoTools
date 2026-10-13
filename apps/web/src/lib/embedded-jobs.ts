import type { EngineInfo, FileKind, FileRef, JobRequest, JobSnapshot } from 'core';
import { Channel } from '@tauri-apps/api/core';
import type { ResolvedInput } from './engine-types.ts';
import { callEmbeddedRpc, cancelEmbeddedFileJob, materializeInput } from './embedded-engine.ts';
import { contentInsetsRuntimeData, removeBlankInkRuntimeData } from './pdf-content-insets.ts';
import { markupNeedsUnicodeFont, markdownRuntimeData, ofdRuntimeData, systemFontRuntimeData } from './file-runtime-data.ts';
import { authorizeOutputDir, authorizeTempDir, engineBridge, isTauri } from './tauri.ts';
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
  /**
   * `reference` resolves a disk-backed file without pulling its bytes across the
   * bridge; the runner only sets it for a native tool whose every input already
   * lives on disk.
   */
  resolveInput(file: FileRef, options?: { reference?: boolean }): Promise<ResolvedInput>;
  /** Publishes a job snapshot event; the runner already updated its own map. */
  publish(snapshot: JobSnapshot): void;
  tempDir(): string | null;
  defaultTempDir(): string | null;
  ensureRuntime(): Promise<EngineInfo>;
}

/** Job states that must not be reversed by a later event. */
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled']);

/**
 * Bytes for an input that was resolved by reference. Only the steps that truly
 * need the content ask: an adapter pre-pass, or the Worker fallback after the
 * native route declined to handle the tool at all.
 */
async function materializeResolved(input: ResolvedInput): Promise<Uint8Array> {
  if (input.bytes.byteLength || !input.path || !isTauri()) return materializeInput(input);
  const bridge = await engineBridge();
  const value = await bridge.invoke<ArrayBuffer | Uint8Array | number[]>('read_file_binary', { path: input.path });
  return Array.isArray(value)
    ? Uint8Array.from(value)
    : value instanceof Uint8Array
      ? value.slice()
      : new Uint8Array(value);
}

/**
 * Ask the host to stop a running native job. The invoke that is already in flight
 * cannot be abandoned, so the runner's terminal guard is what keeps a late
 * `succeeded` reply from overwriting the cancelled state the user acted on.
 */
async function cancelNativeJob(jobId: string): Promise<void> {
  try {
    await (await engineBridge()).invoke('cancel_native_job', { jobId });
  } catch {
    // The job is either finished or never started natively; locally it is already
    // terminal, which is the only state the UI can act on.
  }
}

/** Browser/network precomputation for text tools dispatched through tool.run. */
export async function textToolRuntimeData(tool: string, options: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  let runtimeData: Record<string, unknown> | undefined;
  if (tool === 'ip-lookup') {
    // The only outbound call the desktop shell makes from the WebView, so its host
    // is allow-listed in `app.security.csp` (`connect-src … https://ip.bt.cn`).
    // Leaving that entry out does not throw: the fetch rejects and the result
    // silently degrades to the `network` status, which is why the packaged build
    // has to be checked rather than the dev server.
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
    // RUN-01: for a native tool whose every input is already a file on disk, the
    // bytes never need to reach JavaScript at all. Anything that later needs them
    // — an adapter pre-pass, or the Worker because the native route declined —
    // reads them through `materializeResolved`.
    const reference = isTauri()
      && RUST_NATIVE_FILE_TOOLS.has(request.tool)
      && (request.files ?? []).every((file) => Boolean(file.path));
    let inputs: ResolvedInput[];
    let failedInput: { file: FileRef; error: unknown } | undefined;
    try {
      inputs = await Promise.all((request.files ?? []).map(async (file: FileRef) => {
        try {
          return await this.host.resolveInput(file, { reference });
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
      // RUN-02: the Worker controller cannot interrupt an already-dispatched
      // native command, so the host is told too — it stops reading inputs and
      // refuses to write any artifact from that point on.
      if (isTauri() && RUST_NATIVE_FILE_TOOLS.has(job.tool)) void cancelNativeJob(jobId);
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
    await authorizeOutputDir(dir);
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
      code: !file
        ? error instanceof RpcError ? error.code : 'bad_request'
        : missing
          ? 'fileMissing'
          : hasPath
            ? 'fileUnreadable'
            : 'bad_request',
      message: !file
        ? detail
        : missing
          ? `${file.name || file.path} 已不存在，可能已被移动、删除或清理`
          : hasPath
            ? `无法读取 ${file.name || file.path}: ${detail}`
            : detail,
      // Kept so message tables can name the file and the reason in any locale.
      details: file ? { file: file.name || file.path, detail } : undefined,
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
      // The ink/insets builders rasterize with main-thread pdf.js, which needs
      // real bytes — resolved File-backed inputs carry their payload out of
      // band, so materialize before handing them over. A reference-resolved
      // native input is read here, at the step that actually needs pixels.
      const rasterInputs = async () => Promise.all(inputs.map(async (input) => ({ id: input.id, bytes: await materializeResolved(input) })));
      const contentInsetsData = (request.tool === 'invoice-merge' && autoCrop)
        || (request.tool === 'crop' && shrinkToContent)
        ? await contentInsetsRuntimeData(await rasterInputs(), request.globals?.password)
        : undefined;
      const removeBlankData = request.tool === 'remove-blank'
        ? await removeBlankInkRuntimeData(await rasterInputs(), request.globals?.password)
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
          : request.tool === 'ofd-to-pdf'
            // The engine embeds CJK text from system fonts; without this the
            // ofd import reports unsupported in every browser session.
            ? await systemFontRuntimeData()
            : request.tool === 'pdf-to-ofd' && String(request.options.mode ?? 'text') === 'text'
              ? await ofdRuntimeData(request)
              : undefined);
      if (isTauri() && RUST_NATIVE_FILE_TOOLS.has(request.tool)) {
        const bridge = await engineBridge();
        const runtime = await this.host.ensureRuntime();
        const tempRoot = this.host.tempDir() ?? runtime.defaultTempDir;
        // Both the staging root and the auto-save directory travel as grant-
        // checked parameters, so both are authorized immediately before use.
        if (tempRoot) await authorizeTempDir(tempRoot);
        if (request.output?.dir) await authorizeOutputDir(request.output.dir);
        const running: JobSnapshot = {
          id: request.id,
          tool: request.tool,
          label: request.label,
          fileNames: inputs.map((input) => input.name),
          createdAt: request.createdAt ?? Date.now(),
          progress: { state: 'running', percent: 1, phase: 'prepare' },
          artifacts: [],
          warnings: [],
        };
        this.publish(running);
        // Split reports one step per output group; without the channel a big
        // job sat at 1% for its whole run and the UI looked dead.
        const progress = new Channel<{ done: number; total: number }>();
        progress.onmessage = (step) => {
          const total = Math.max(1, step.total ?? 0);
          const percent = 1 + Math.round((Math.min(step.done ?? 0, total) / total) * 98);
          this.publish({ ...running, progress: { state: 'running', percent, phase: 'process' } });
        };
        const native = await bridge.invoke<{
          handled: boolean;
          result?: {
            text: string;
            artifacts: Array<{ name: string; kind: string; sizeBytes: number; sourceFileId?: string; stagedPath?: string; outputPath?: string | null; dataBase64?: string }>;
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
          // On-disk files stay on disk: the command reads them by path and
          // writes outputs straight to the temp dir, so no multi-MB base64
          // payload crosses the bridge in either direction. Pasted files
          // (File carriers, no path) would otherwise reach the engine as
          // empty bytes — materialize their content here.
          inputs: await Promise.all(inputs.map(async (input) => {
            if (input.path) return { id: input.id, name: input.name, path: input.path };
            const carrier = (input as ResolvedInput & { file?: File }).file;
            const bytes = input.bytes.byteLength || !carrier
              ? input.bytes
              : new Uint8Array(await carrier.arrayBuffer());
            return { id: input.id, name: input.name, path: null, dataBase64: encodeBase64(bytes) };
          })),
          jobId: request.id,
          tempRoot: tempRoot || null,
          outputDir: request.output?.dir ?? null,
          onProgress: progress,
        });
        if (native.error) {
          throw new RpcError(native.error.code ?? 'internal', native.error.message ?? 'Rust 引擎执行失败', native.error.hintKey);
        }
        if (native.handled && native.result) {
          const stagedToDisk = Boolean(tempRoot)
            && native.result.artifacts.length > 0
            && native.result.artifacts.every((artifact) => typeof artifact.stagedPath === 'string' && artifact.stagedPath.length > 0);
          const outputArtifacts = native.result.artifacts.map((artifact, index) => ({
            id: String(index + 1),
            name: artifact.name,
            kind: artifact.kind as FileKind,
            sourceFileId: artifact.sourceFileId,
            stagedPath: stagedToDisk ? artifact.stagedPath! : undefined,
            outputPath: stagedToDisk ? artifact.outputPath ?? null : undefined,
            bytes: stagedToDisk ? undefined : decodeBase64(artifact.dataBase64 ?? ''),
          }));
          // A reference-resolved input carries no bytes by design; its on-disk
          // size is what the summary needs.
          const inputBytes = inputs.reduce((sum, input) => sum + (input.bytes.byteLength || input.sizeBytes || 0), 0);
          const outputBytes = stagedToDisk
            ? native.result.artifacts.reduce((sum, artifact) => sum + (artifact.sizeBytes ?? 0), 0)
            : outputArtifacts.reduce((sum, artifact) => sum + (artifact.bytes?.byteLength ?? 0), 0);
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
              path: stagedToDisk ? (artifact.outputPath ?? artifact.stagedPath!) : null,
              sizeBytes: stagedToDisk
                ? native.result!.artifacts[Number(artifact.id) - 1]?.sizeBytes ?? 0
                : artifact.bytes?.byteLength ?? 0,
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
        // The Worker needs real content. An input the native route would have read
        // by path — because the tool declined it, or a pre-pass never asked for
        // pixels — is fetched here and only here.
        const workerInputs = await Promise.all(inputs.map(async (input) => (
          input.bytes.byteLength || !input.path
            ? input
            : { ...input, bytes: await materializeResolved(input) }
        )));
        embedded = await callEmbeddedRpc('job.submit', { job: request }, {
          inputs: workerInputs,
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
        // RUN-04: the failure stays in the job map. Dropping it here made the
        // record vanish on the next refresh, so a job the user could see fail
        // became invisible — and uncopyable for a bug report.
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
          // RUN-02: staging runs *after* the engine finished, so the cancel flag
          // has to be re-read here. Without this a job the user cancelled still
          // wrote every artifact into the output directory — the terminal guard
          // only fixed what the UI displayed, not what reached disk. Temp copies
          // are deliberately left in place so nothing already staged is lost.
          if (this.stateOf(request.id) === 'cancelled') {
            console.warn('[potools] job cancelled before staging; no artifact written', request.tool, request.id);
            return;
          }
          const artifact = artifacts[index];
          const snapshotArtifact = final.artifacts[index];
          if (!artifact || !snapshotArtifact) continue;
          // The native command already wrote this one to the temp dir (and to
          // the output dir when picked); only the bookkeeping is missing.
          if (artifact.stagedPath) {
            snapshotArtifact.name = artifact.name;
            snapshotArtifact.path = artifact.outputPath ?? artifact.stagedPath;
            this.artifactPaths.set(`${request.id}:${snapshotArtifact.id}`, artifact.stagedPath);
            this.artifactRoots.set(`${request.id}:${snapshotArtifact.id}`, tempRoot);
            continue;
          }
          const bytes = artifact.bytes!.slice().buffer as ArrayBuffer;
          // Both the staging root and the auto-save directory travel in headers,
          // so both are authorized immediately before use.
          await authorizeTempDir(tempRoot);
          await authorizeOutputDir(request.output?.dir);
          // IPC header values must stay Latin-1 — WebKit throws a bare
          // "Type error" TypeError on non-ASCII names and paths — so every
          // free-text header travels percent-encoded.
          const staged = await bridge.invoke<{ stagedPath: string; outputPath?: string; name: string }>(
            'stage_job_artifact_binary',
            bytes,
            {
              headers: {
                'x-potools-job-id': request.id,
                'x-potools-name': encodeURIComponent(artifact.name),
                'x-potools-output-dir': request.output?.dir ? encodeURIComponent(request.output.dir) : '',
                'x-potools-temp-root': encodeURIComponent(tempRoot),
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
            if (!artifact || !snapshotArtifact || !artifact.bytes) continue;
            snapshotArtifact.dataBase64 = encodeBase64(artifact.bytes);
          }
        }
      }
      this.publish(final);
    } catch (error) {
      const current = this.jobs.get(request.id);
      if (!current || current.progress.state === 'cancelled') return;
      // The result panel shows message+code only; the raw error (name, stack,
      // non-Error rejection values) is what makes IPC failures diagnosable.
      console.error('PoTools⏱ job.failed', request.tool, request.id, error, (error as Error)?.stack);
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

  /** The runner's own view of one job's state, terminal guard included. */
  private stateOf(jobId: string): JobSnapshot['progress']['state'] | null {
    return this.jobs.get(jobId)?.progress.state ?? null;
  }

  private publish(snapshot: JobSnapshot): void {
    // RUN-02: once a job is terminal it stays terminal. A native invoke cannot be
    // abandoned, so the reply a cancelled job eventually sends — and any late
    // progress tick — must not reverse the state the user acted on. Republishing
    // the *same* terminal state is allowed, because staging rewrites artifact
    // paths onto the final snapshot.
    const previous = this.jobs.get(snapshot.id);
    if (previous
      && TERMINAL_STATES.has(previous.progress.state)
      && previous.progress.state !== snapshot.progress.state) {
      return;
    }
    this.jobs.set(snapshot.id, snapshot);
    this.host.publish(snapshot);
  }
}
