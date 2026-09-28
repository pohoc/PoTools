import { PROTOCOL_VERSION, TOOL_LIST, type DirListing, type EngineEvent, type EngineInfo, type FileRef, type InvoiceScanEntry, type InvoiceScanResult, type JobRequest, type JobSnapshot, type RpcMethodName } from 'core';
import type { ResolvedInput } from '@potools/engine/browser';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import { engineBridge, isTauri } from './tauri.ts';
import { callEmbeddedRpc, cancelEmbeddedFileJob, configureEmbeddedWorkerPool, embeddedWorkerCount, shutdownEmbeddedWorkerPool } from './embedded-engine.ts';

export type TransportStatus = 'connecting' | 'ready' | 'offline';

export class RpcError extends Error {
  readonly code: string;
  readonly hintKey?: string;

  constructor(code: string, message: string, hintKey?: string) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.hintKey = hintKey;
  }
}

export interface Transport {
  readonly mode: 'web' | 'tauri';
  status: TransportStatus;
  info: EngineInfo | null;
  start(options?: { concurrency?: number }): Promise<EngineInfo>;
  call<T>(method: RpcMethodName, params: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  onEvent(handler: (event: EngineEvent) => void): () => void;
  onStatus(handler: (status: TransportStatus) => void): () => void;
  stop(): void;
}

let counter = 0;
const nextId = (): string => `r${Date.now().toString(36)}${(counter += 1)}`;

function relativeAssetPath(markdownPath: string, source: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(source);
  } catch {
    throw new URIError(`Malformed URI in Markdown image path: ${source}`);
  }
  if (!decoded || decoded.startsWith('//') || decoded.startsWith('\\\\') || /^[a-z][a-z\d+.-]*:/i.test(decoded)) return null;

  const separator = markdownPath.lastIndexOf('/') > markdownPath.lastIndexOf('\\') ? '/' : '\\';
  const separatorIndex = markdownPath.lastIndexOf(separator);
  if (separatorIndex < 0) return null;
  const directory = markdownPath.slice(0, separatorIndex + 1);
  const driveRooted = /^[A-Za-z]:\\/.test(markdownPath);
  const rooted = markdownPath.startsWith('/') || driveRooted;
  const joined = `${directory}${decoded.replace(/[\\/]/g, separator)}`;
  const prefix = driveRooted ? joined.slice(0, 3) : rooted ? separator : '';
  const body = driveRooted ? joined.slice(3) : rooted ? joined.slice(1) : joined;
  const parts: string[] = [];
  for (const part of body.split(/[\\/]+/)) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length) parts.pop();
      else if (!rooted) parts.push(part);
      continue;
    }
    parts.push(part);
  }
  return `${prefix}${parts.join(separator)}`;
}

abstract class BaseTransport implements Transport {
  abstract readonly mode: 'web' | 'tauri';
  status: TransportStatus = 'connecting';
  info: EngineInfo | null = null;
  protected eventHandlers = new Set<(event: EngineEvent) => void>();
  protected statusHandlers = new Set<(status: TransportStatus) => void>();

  abstract start(options?: { concurrency?: number }): Promise<EngineInfo>;
  abstract call<T>(method: RpcMethodName, params: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  abstract stop(): void;

  onEvent(handler: (event: EngineEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  onStatus(handler: (status: TransportStatus) => void): () => void {
    this.statusHandlers.add(handler);
    handler(this.status);
    return () => this.statusHandlers.delete(handler);
  }

  protected emitEvent(event: EngineEvent): void {
    for (const handler of this.eventHandlers) handler(event);
  }

  protected setStatus(status: TransportStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const handler of this.statusHandlers) handler(status);
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const source = value.replace(/-/g, '+').replace(/_/g, '/');
  const prefix = source.match(/^[A-Za-z0-9+/]*/)?.[0] ?? '';
  const usable = prefix.length % 4 === 1 ? prefix.slice(0, -1) : prefix;
  const binary = atob(usable.padEnd(Math.ceil(usable.length / 4) * 4, '='));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

class TauriTransport extends BaseTransport {
  readonly mode: 'web' | 'tauri' = isTauri() ? 'tauri' : 'web';
  private ready: Promise<EngineInfo> | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private healthInFlight = false;
  private embeddedJobs = new Map<string, JobSnapshot>();
  private embeddedArtifactPaths = new Map<string, string>();
  private embeddedArtifactRoots = new Map<string, string>();
  private embeddedQueue: Array<{ request: JobRequest; inputs: ResolvedInput[] }> = [];
  private embeddedActive = 0;
  private embeddedConcurrency = 1;
  private tempDir: string | null = null;
  private systemFontCandidates: Promise<string[]> | null = null;
  private systemFontBytes = new Map<string, Promise<Uint8Array | null>>();

  private requireNativeHost(): Promise<Awaited<ReturnType<typeof engineBridge>>> {
    if (!isTauri()) throw new RpcError('unsupported', '此功能需要 PoTools 桌面版提供的本机文件系统');
    return engineBridge();
  }

  /**
   * The Node sidecar is gone from the shipped app: every RPC resolves through
   * the embedded Worker plus host commands, and unsupported inputs fail
   * explicitly instead of booting a sidecar.
   */

  async start(options?: { concurrency?: number }): Promise<EngineInfo> {
    if (this.ready) return this.ready;
    this.embeddedConcurrency = Math.max(1, Math.min(4, Math.trunc(options?.concurrency ?? 1)));
    configureEmbeddedWorkerPool(this.embeddedConcurrency);
    this.ready = this.bootstrap(options?.concurrency);
    return this.ready;
  }

  private async bootstrap(concurrency?: number): Promise<EngineInfo> {
    const platform = typeof navigator !== 'undefined' ? navigator.platform : 'unknown';
    const bridge = isTauri() ? await engineBridge() : null;
    const host = bridge
      ? await bridge.invoke<{ platform: string; defaultOutputDir: string; defaultTempDir: string }>('desktop_runtime_info')
      : { platform, defaultOutputDir: '', defaultTempDir: '' };
    this.embeddedConcurrency = Math.max(1, Math.min(4, Math.trunc(concurrency ?? 1)));
    configureEmbeddedWorkerPool(this.embeddedConcurrency);
    // Real self-check values: the embedded Worker bundles MuPDF WASM (rasterizer),
    // canvas codecs serve image transcoding, and host-discovered fonts cover CJK.
    const fontCandidates = bridge
      ? await bridge.invoke<string[]>('system_font_candidates').catch(() => [] as string[])
      : [];
    const info: EngineInfo = {
      name: '@potools/engine',
      version: '0.1.0',
      protocol: PROTOCOL_VERSION,
      platform: host.platform,
      nodeVersion: 'Web Worker',
      pid: 0,
      defaultOutputDir: host.defaultOutputDir,
      tempDir: this.tempDir ?? host.defaultTempDir,
      defaultTempDir: host.defaultTempDir,
      features: {
        rasterizer: 'mupdf',
        imageCodec: typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function',
        cjkFont: fontCandidates[0]?.split(/[\\/]/).pop() ?? null,
        busy: false,
      },
    };
    this.info = info;
    this.setStatus('ready');
    this.startHealthCheck();
    return info;
  }

  private async localInfo<T>(): Promise<T> {
    if (!this.info) return (await this.start()) as T;
    return this.info as T;
  }

  private async resolveInput(file: FileRef): Promise<ResolvedInput> {
    let bytes: Uint8Array;
    if (file.path) {
      const bridge = await this.requireNativeHost();
      const value = await bridge.invoke<ArrayBuffer | Uint8Array | number[]>('read_file_binary', { path: file.path });
      bytes = Array.isArray(value) ? Uint8Array.from(value) : value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value);
    } else if (file.dataBase64) {
      bytes = decodeBase64(file.dataBase64);
    } else if (typeof File !== 'undefined' && (file as FileRef & { file?: File }).file instanceof File) {
      const browserFile = (file as FileRef & { file: File }).file;
      return { id: file.id, name: file.name, path: null, bytes: new Uint8Array(), file: browserFile } as ResolvedInput & { file: File };
    } else {
      throw new RpcError('bad_request', `${file.name || '文件'} 缺少路径或内容`);
    }
    return { id: file.id, name: file.name, path: file.path ?? null, bytes };
  }

  private async tryEmbeddedFileRpc<T>(method: RpcMethodName, params: Record<string, unknown>): Promise<{ handled: boolean; result?: T }> {
    if (!params.file || typeof params.file !== 'object') return { handled: false };
    const input = await this.resolveInput(params.file as FileRef);
    const workerParams = method === 'page.thumbs' ? { ...params, workerSrc: pdfWorkerUrl } : params;
    const reply = await callEmbeddedRpc(method, workerParams, { inputs: [input] });
    if (!reply.handled) throw new RpcError('unsupported', `${method} 不支持此文件或当前浏览器环境`);
    return { handled: true, result: reply.result as T };
  }

  private async scanInvoices<T>(params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const bridge = await this.requireNativeHost();
    let listing: {
      sourceDirectory: string;
      files: Array<{ path: string; relativePath: string; name: string; extension: string; sizeBytes: number }>;
      skipped: InvoiceScanResult['skipped'];
      exceeded: boolean;
    };
    try {
      listing = await bridge.invoke('invoice_scan_list', {
        directory: String(params.directory ?? ''),
        recursive: params.recursive !== false,
        maxFiles: params.maxFiles,
        excludeDirectory: params.excludeDirectory,
      });
    } catch (error) {
      const message = String(error);
      throw new RpcError(message.includes('无法访问来源目录') ? 'unreadable_file' : 'bad_request', message);
    }

    const filesByIndex: Array<InvoiceScanEntry | undefined> = new Array(listing.files.length);
    const files: InvoiceScanEntry[] = [];
    const skipped = [...listing.skipped];
    const emptyFields = (): InvoiceScanEntry['fields'] => ({ date: '', seller: '', buyer: '', invoiceNo: '', amount: '', type: '' });
    const analyzeCandidate = async (candidate: typeof listing.files[number], index: number): Promise<void> => {
      let loaded: { bytes: ArrayBuffer | Uint8Array | number[]; currentSizeBytes: number; changedWhileReading: boolean };
      try {
        loaded = await bridge.invoke('invoice_read_candidate', {
          path: candidate.path,
          expectedSizeBytes: candidate.sizeBytes,
        });
      } catch (error) {
        const message = String(error);
        if (message.includes('已跳过') || message.includes('单文件 100 MB 上限')) {
          skipped.push({ relativePath: candidate.relativePath, reason: message.includes('已跳过') ? '文件状态已变化，已跳过' : '超过单文件 100 MB 上限' });
        } else {
          filesByIndex[index] = { ...candidate, sizeBytes: 0, sha256: '', pageCount: null, extractedText: '', recognition: 'failed', fields: emptyFields(), error: message };
        }
        return;
      }
      const bytes = loaded.bytes instanceof ArrayBuffer
        ? new Uint8Array(loaded.bytes)
        : Array.isArray(loaded.bytes) ? Uint8Array.from(loaded.bytes) : new Uint8Array(loaded.bytes);
      if (bytes.byteLength > 100 * 1024 * 1024) {
        skipped.push({ relativePath: candidate.relativePath, reason: '扫描期间文件发生变化或超过大小上限' });
        return;
      }
      const input: ResolvedInput = { id: `invoice-${index}`, name: candidate.name, path: candidate.path, bytes };
      try {
        const embedded = await callEmbeddedRpc('invoice.scan', {
          file: { ...candidate, changedWhileReading: loaded.changedWhileReading },
        }, { inputs: [input] });
        if (!embedded.handled) {
          filesByIndex[index] = { ...candidate, sizeBytes: candidate.sizeBytes, sha256: '', pageCount: null, extractedText: '', recognition: 'failed', fields: emptyFields(), error: '内嵌 Worker 无法解析该发票' };
          return;
        }
        const analyzed = embedded.result as { entry?: InvoiceScanEntry; skipped?: InvoiceScanResult['skipped'][number] } | undefined;
        if (analyzed?.entry) filesByIndex[index] = analyzed.entry;
        if (analyzed?.skipped) skipped.push(analyzed.skipped);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        filesByIndex[index] = { ...candidate, sizeBytes: candidate.sizeBytes, sha256: '', pageCount: null, extractedText: '', recognition: 'failed', fields: emptyFields(), error: message };
      }
    };
    const batchSize = embeddedWorkerCount();
    for (let start = 0; start < listing.files.length; start += batchSize) {
      const batch = listing.files.slice(start, start + batchSize);
      await Promise.all(batch.map((candidate, offset) => analyzeCandidate(candidate, start + offset)));
    }
    files.push(...filesByIndex.filter((entry): entry is InvoiceScanEntry => Boolean(entry)));
    return {
      sourceDirectory: listing.sourceDirectory,
      scannedAt: Date.now(),
      files,
      skipped,
      warnings: ['ocr-unavailable', ...(listing.exceeded ? ['scan-limit-reached'] : [])],
    } as T;
  }

  async call<T>(method: RpcMethodName, params: Record<string, unknown>, timeoutMs = 120_000): Promise<T> {
    if (method === 'engine.info') return this.localInfo<T>();
    if (method === 'engine.ping') {
      return { pong: Date.now() } as T;
    }
    if (method === 'engine.setTempDir') {
      this.tempDir = typeof params.dir === 'string' && params.dir.trim() ? params.dir.trim() : null;
      if (this.info) this.info = { ...this.info, tempDir: this.tempDir ?? this.info.defaultTempDir };
      return { tempDir: this.tempDir ?? this.info?.defaultTempDir ?? '' } as T;
    }
    if (method === 'tools.list') return TOOL_LIST as T;
    if (method === 'temp.stat' || method === 'temp.clean') {
      if (!this.info) await this.start();
      const bridge = await this.requireNativeHost();
      const root = this.tempDir ?? this.info?.defaultTempDir ?? '';
      if (method === 'temp.stat') return await bridge.invoke('temp_usage', { root }) as T;
      const protectJobs = [...this.embeddedJobs.values()]
        .filter((job) => job.progress.state === 'queued' || job.progress.state === 'running')
        .map((job) => job.id);
      return await bridge.invoke('temp_clean', {
        root,
        olderThanDays: Number(params.olderThanDays ?? 0),
        keepJobs: Number(params.keepJobs ?? 0),
        protectJobs: [...new Set(protectJobs)],
      }) as T;
    }
    if (method === 'fs.browse') {
      try {
        const bridge = await this.requireNativeHost();
        return await bridge.invoke<DirListing>('browse_directories', {
          path: typeof params.path === 'string' ? params.path : null,
        }) as T;
      } catch {
        throw new RpcError('unsupported', '目录读取需要 PoTools 桌面版提供的本机文件系统');
      }
    }
    if (method === 'page.thumbs' || method === 'file.probe' || method === 'page.list') {
      const embedded = await this.tryEmbeddedFileRpc<T>(method, params);
      if (embedded.handled) return embedded.result as T;
    }
    if (method === 'file.bytes' && params.file && typeof params.file === 'object') {
      const file = params.file as FileRef & { file?: File };
      if (file.path) {
        const bridge = await this.requireNativeHost();
        const bytes = new Uint8Array(await bridge.invoke<ArrayBuffer>('read_file_binary', { path: file.path }));
        return { dataBase64: encodeBase64(bytes), name: file.name } as T;
      }
      if (file.dataBase64) return { dataBase64: file.dataBase64, name: file.name } as T;
      if (typeof File !== 'undefined' && file.file instanceof File) return { dataBase64: encodeBase64(new Uint8Array(await file.file.arrayBuffer())), name: file.name } as T;
    }
    if (method === 'shell.reveal' && typeof params.path === 'string') {
      const bridge = await this.requireNativeHost();
      await bridge.invoke('open_path', { path: params.path, reveal: params.open !== true });
      return { revealed: true, path: params.path } as T;
    }
    if (method === 'shell.print' && typeof params.path === 'string') {
      const bridge = await this.requireNativeHost();
      try {
        return await bridge.invoke<T>('print_file', { path: params.path });
      } catch (error) {
        throw new RpcError('bad_request', String(error));
      }
    }
    if (method === 'invoice.scan') return this.scanInvoices<T>(params, timeoutMs);
    if (method === 'invoice.archive' && params && typeof params === 'object') {
      const bridge = await this.requireNativeHost();
      try {
        return await bridge.invoke<T>('invoice_archive', { input: params });
      } catch (error) {
        throw new RpcError('bad_request', String(error));
      }
    }
    if (method === 'invoice.undo' && typeof params.archiveId === 'string') {
      const bridge = await this.requireNativeHost();
      try {
        return await bridge.invoke<T>('invoice_undo', { archiveId: params.archiveId });
      } catch (error) {
        throw new RpcError('bad_request', String(error));
      }
    }
    if (method === 'file.write' && typeof params.dataBase64 === 'string') {
      if (!isTauri()) {
        const bytes = decodeBase64(params.dataBase64);
        const blob = new Blob([bytes.slice().buffer as ArrayBuffer]);
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = String(params.name ?? 'output.txt');
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        return { path: anchor.download, name: anchor.download } as T;
      }
      const bytes = decodeBase64(params.dataBase64);
      const bridge = await this.requireNativeHost();
      return bridge.invoke<T>('write_output_file', {
        dir: String(params.dir ?? ''),
        name: String(params.name ?? 'output.txt'),
        bytes: Array.from(bytes),
      });
    }
    if (method === 'job.list') return [...this.embeddedJobs.values()] as T;
    if (method === 'tool.run') {
      const tool = String(params.tool ?? '');
      let runtimeData: Record<string, unknown> | undefined;
      if (tool === 'dns-lookup') {
        try {
          const bridge = await this.requireNativeHost();
          const options = (params.options ?? {}) as Record<string, unknown>;
          const hostname = String(options.hostname ?? '').replace(/\.$/, '').toLowerCase();
          const recordType = String(options.recordType ?? '').toUpperCase();
          const records = await bridge.invoke<string[]>('dns_lookup', { hostname, recordType });
          runtimeData = { nativeDns: { hostname, recordType, records } };
        } catch (error) {
          throw new RpcError('bad_request', String(error));
        }
      }
      if (['system-network', 'ping-check', 'tcp-check'].includes(tool)) {
        try {
          const bridge = await this.requireNativeHost();
          const options = (params.options ?? {}) as Record<string, unknown>;
          const native = tool === 'system-network'
            ? await bridge.invoke('system_network_probe')
            : tool === 'ping-check'
              ? await bridge.invoke('ping_host', {
                host: String(options.host ?? ''),
                count: Math.max(1, Math.min(10, Math.trunc(Number(options.count ?? 4)))),
              })
              : await bridge.invoke('tcp_check_host', {
                host: String(options.host ?? ''),
                port: (() => {
                  const port = Math.trunc(Number(options.port ?? 0));
                  return port >= 1 && port <= 65535 ? port : 0;
                })(),
              });
          runtimeData = { nativeNetwork: { ...(native as Record<string, unknown>), kind: tool } };
        } catch (error) {
          throw new RpcError('bad_request', String(error));
        }
      }
      const embedded = await callEmbeddedRpc(method, params, { runtimeData });
      if (embedded.handled) return embedded.result as T;
    }
    if (method === 'job.submit' && params.job && typeof params.job === 'object') {
      return this.submitEmbeddedJob<T>(params.job as JobRequest);
    }
    if (method === 'job.cancel') {
      const jobId = String(params.jobId ?? '');
      const job = this.embeddedJobs.get(jobId);
      if (job && ['queued', 'running'].includes(job.progress.state)) {
        const queuedIndex = this.embeddedQueue.findIndex((entry) => entry.request.id === jobId);
        if (queuedIndex >= 0) {
          this.embeddedQueue.splice(queuedIndex, 1);
          this.publishEmbeddedJob({
            ...job,
            finishedAt: Date.now(),
            progress: { state: 'cancelled', percent: 0 },
          });
        } else {
          cancelEmbeddedFileJob(jobId);
          this.publishEmbeddedJob({
            ...job,
            finishedAt: Date.now(),
            progress: { state: 'cancelled', percent: 0 },
          });
        }
        return { cancelled: true } as T;
      }
      return { cancelled: false } as T;
    }
    if (method === 'job.clear') {
      const jobIds = params.jobIds as string[] | undefined;
      const ids = jobIds ?? [...this.embeddedJobs.keys()];
      const removed = ids.filter((id) => {
        const job = this.embeddedJobs.get(id);
        if (!job || !['succeeded', 'failed', 'cancelled'].includes(job.progress.state)) return false;
        this.embeddedJobs.delete(id);
        for (const artifact of job.artifacts) {
          const key = `${id}:${artifact.id}`;
          this.embeddedArtifactPaths.delete(key);
          this.embeddedArtifactRoots.delete(key);
        }
        return true;
      });
      return { removed: removed.length } as T;
    }
    if (method === 'file.write' && typeof params.jobId === 'string' && typeof params.artifactId === 'string') {
      const artifactKey = `${params.jobId}:${params.artifactId}`;
      const staged = this.embeddedArtifactPaths.get(artifactKey);
      const tempRoot = this.embeddedArtifactRoots.get(artifactKey);
      if (staged) {
        const bridge = await this.requireNativeHost();
        const path = await bridge.invoke<string>('copy_staged_artifact', {
          from: staged,
          dir: String(params.dir ?? ''),
          name: String(params.name ?? ''),
          tempRoot: tempRoot ?? this.tempDir ?? this.info?.defaultTempDir ?? '',
        });
        return { path, name: path.split(/[\\/]/).pop() } as T;
      }
    }
    return this.callSidecar<T>(method, params);
  }

  private async submitEmbeddedJob<T>(request: JobRequest): Promise<T> {
    let inputs: ResolvedInput[];
    let failedInput: { file: FileRef; error: unknown } | undefined;
    try {
      inputs = await Promise.all((request.files ?? []).map(async (file: FileRef) => {
        try {
          return await this.resolveInput(file);
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
    this.embeddedJobs.set(request.id, snapshot);
    this.embeddedQueue.push({ request, inputs });
    this.pumpEmbeddedJobs();
    return snapshot as T;
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
    this.publishEmbeddedJob(snapshot);
    snapshot.progress = { state: 'running', percent: 1, phase: 'prepare' };
    this.publishEmbeddedJob(snapshot);

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
    this.publishEmbeddedJob(snapshot);
    return snapshot as T;
  }

  private pumpEmbeddedJobs(): void {
    while (this.embeddedActive < this.embeddedConcurrency && this.embeddedQueue.length) {
      const queued = this.embeddedQueue.shift();
      if (!queued) break;
      this.embeddedActive += 1;
      void this.runEmbeddedJob(queued.request, queued.inputs).finally(() => {
        this.embeddedActive -= 1;
        this.pumpEmbeddedJobs();
      });
    }
  }

  private async runEmbeddedJob(request: JobRequest, inputs: ResolvedInput[]): Promise<void> {
    try {
      const runtimeData = request.tool === 'markdown-to-pdf'
        ? await this.markdownRuntimeData(request, inputs)
        : request.tool === 'pdf-to-ofd' && String(request.options.mode ?? 'text') === 'text'
          ? await this.ofdRuntimeData(request)
          : ['watermark', 'page-numbers', 'header-footer'].includes(request.tool) && this.markupNeedsUnicodeFont(request, inputs)
            ? await this.systemFontRuntimeData(request.globals?.fontPath)
            : undefined;
      const embedded = await callEmbeddedRpc('job.submit', { job: request }, {
        inputs,
        runtimeData,
        onProgress: (progress) => {
          if (progress.progress.state === 'running') this.publishEmbeddedJob(progress);
        },
      });
      if (!embedded.handled) {
        // No sidecar fallback: the tool cannot run on this input in the
        // worker, so the job fails with the established unsupported contract.
        const current = this.embeddedJobs.get(request.id);
        if (current) {
          this.publishEmbeddedJob({
            ...current,
            finishedAt: Date.now(),
            progress: { state: 'failed', percent: current.progress.percent },
            error: { code: 'unsupported', message: '该输入在当前内置引擎下不受支持，请更新 PoTools' },
          });
        }
        this.embeddedJobs.delete(request.id);
        return;
      }
      const result = embedded.jobResult;
      if (!result?.snapshot) return;
      const final = result.snapshot;
      if (final.progress.state === 'succeeded') {
        const bridge = await engineBridge();
        const runtime = this.info ?? await this.start();
        const tempRoot = this.tempDir ?? runtime.defaultTempDir;
        const artifacts = result.artifacts ?? [];
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
          this.embeddedArtifactPaths.set(`${request.id}:${snapshotArtifact.id}`, staged.stagedPath);
          this.embeddedArtifactRoots.set(`${request.id}:${snapshotArtifact.id}`, tempRoot);
        }
      }
      this.publishEmbeddedJob(final);
    } catch (error) {
      const current = this.embeddedJobs.get(request.id);
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
      this.publishEmbeddedJob(failed);
    }
  }

  private async markdownRuntimeData(request: JobRequest, inputs: ResolvedInput[]): Promise<Record<string, unknown>> {
    const bridge = await engineBridge();
    const runtimeData: Record<string, unknown> = {};
    const fontPath = request.globals?.fontPath;
    if (fontPath) {
      try {
        runtimeData.markdownFontBytes = await this.readFileBinary(bridge, fontPath);
      } catch { /* The compatibility engine will report the established font error. */ }
    }
    const markdownAssets: Record<string, Uint8Array> = {};
    for (const input of inputs) {
      if (!input.path) continue;
      const markdown = new TextDecoder('utf-8').decode(input.bytes);
      const references = [...markdown.matchAll(/^!\[[^\]]*\]\(([^)]+)\)\s*$/gm)];
      for (const reference of references) {
        const source = reference[1]?.trim();
        if (!source) continue;
        const path = relativeAssetPath(input.path, source);
        if (!path) continue;
        try {
          const bytes = await bridge.invoke<ArrayBuffer>('read_file_binary', { path });
          markdownAssets[`${input.id}\0${source}`] = new Uint8Array(bytes);
        } catch { /* Match the original missing-image warning. */ }
      }
    }
    runtimeData.markdownAssets = markdownAssets;
    if (!fontPath) Object.assign(runtimeData, await this.systemFontRuntimeData());
    return runtimeData;
  }

  private async ofdRuntimeData(request: JobRequest): Promise<Record<string, unknown>> {
    const path = String(request.globals?.fontPath ?? '');
    if (path) {
      try {
        const bridge = await engineBridge();
        const bytes = await this.readFileBinary(bridge, path);
        const fileName = path.split(/[\\/]/).pop() ?? path;
        const dot = fileName.lastIndexOf('.');
        const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
        const extension = dot > 0 ? fileName.slice(dot + 1) : '';
        const name = `${stem.replace(/[^\w.-]/g, '_')}${extension ? `.${extension}` : ''}`;
        return { ofdFont: { name, bytes } };
      } catch {
        // Preserve the compatibility engine's configured-font error behavior.
        return {};
      }
    }
    return this.systemFontRuntimeData();
  }

  private markupNeedsUnicodeFont(request: JobRequest, inputs: ResolvedInput[]): boolean {
    const options = request.options ?? {};
    const text = [options.text, options.format, options.header, options.footer, ...inputs.map((input) => input.name)]
      .filter((value): value is string => typeof value === 'string')
      .join(' ');
    return /[^\x00-\x7f]/u.test(text);
  }

  private async systemFontRuntimeData(explicitPath?: string | null): Promise<Record<string, unknown>> {
    try {
      const bridge = await engineBridge();
      this.systemFontCandidates ??= bridge.invoke<string[]>('system_font_candidates').catch(() => []);
      const paths = [...new Set([explicitPath, ...(await this.systemFontCandidates)].filter((path): path is string => Boolean(path?.trim())))];
      const fonts: Array<{ name: string; bytes: Uint8Array }> = [];
      const maxFontCount = 8;
      const maxFontBytes = 128 * 1024 * 1024;
      let totalFontBytes = 0;
      for (const path of paths) {
        if (fonts.length >= maxFontCount || totalFontBytes >= maxFontBytes) break;
        let pending = this.systemFontBytes.get(path);
        if (!pending) {
          pending = this.readFileBinary(bridge, path)
            .catch(() => null);
          this.systemFontBytes.set(path, pending);
        }
        const bytes = await pending;
        if (!bytes?.byteLength || bytes.byteLength > 64 * 1024 * 1024) continue;
        if (totalFontBytes + bytes.byteLength > maxFontBytes) continue;
        fonts.push({ name: path.split(/[\\/]/).pop() ?? path, bytes });
        totalFontBytes += bytes.byteLength;
      }
      return { systemFonts: fonts };
    } catch {
      return { systemFonts: [] };
    }
  }

  private async readFileBinary(bridge: Awaited<ReturnType<typeof engineBridge>>, path: string): Promise<Uint8Array> {
    const value = await bridge.invoke<ArrayBuffer | Uint8Array | number[]>('read_file_binary', { path });
    if (Array.isArray(value)) return Uint8Array.from(value);
    return value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value);
  }

  private publishEmbeddedJob(snapshot: JobSnapshot): void {
    this.embeddedJobs.set(snapshot.id, snapshot);
    this.emitEvent({
      event: 'job.updated',
      job: {
        ...snapshot,
        fileNames: [...snapshot.fileNames],
        progress: { ...snapshot.progress },
        artifacts: snapshot.artifacts.map((artifact) => ({ ...artifact })),
        warnings: [...snapshot.warnings],
        error: snapshot.error ? { ...snapshot.error } : undefined,
      },
    });
  }

  /**
   * The Node sidecar no longer ships: anything that reaches this point was
   * not handled by the embedded Worker or a host command and fails explicitly.
   */
  private async callSidecar<T = unknown>(method: RpcMethodName, _params: Record<string, unknown>): Promise<T> {
    throw new RpcError('unsupported', `${method} 尚未接入 Worker 或本机宿主`);
  }

  stop(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    this.ready = null;
    shutdownEmbeddedWorkerPool();
  }

  private startHealthCheck(): void {
    // No sidecar to health-check; engine.ping answers locally.
    if (this.healthTimer) return;
    this.healthTimer = setInterval(() => {
      if (this.healthInFlight) return;
      this.healthInFlight = true;
      void this.call<{ pong: number }>('engine.ping', {}, 2500)
        .then(() => this.setStatus('ready'))
        .catch(() => this.setStatus('offline'))
        .finally(() => { this.healthInFlight = false; });
    }, 5000);
  }
}

let singleton: Transport | null = null;

/** All runtime modes use the same embedded Worker dispatcher. */
export function getTransport(_force?: 'http' | 'tauri'): Transport {
  if (singleton) return singleton;
  singleton = new TauriTransport();
  return singleton;
}

export function resetTransport(): void {
  singleton?.stop();
  singleton = null;
}
