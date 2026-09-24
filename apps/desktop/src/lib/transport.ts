import { PROTOCOL_VERSION, TOOL_LIST, type DirListing, type EngineEvent, type EngineInfo, type FileRef, type InvoiceScanEntry, type InvoiceScanResult, type JobRequest, type JobSnapshot, type RpcMethodName } from 'core';
import type { ResolvedInput } from '@potools/engine/browser';
import { canRunEmbeddedRpc } from '@potools/engine/browser-capabilities';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { engineBridge, isTauri } from './tauri.ts';
import { callEmbeddedRpc, cancelEmbeddedFileJob } from './embedded-engine.ts';

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

/**
 * Vite's dev proxy buffers `text/event-stream`, so browser dev reads the event
 * stream straight from the engine origin. The dev signal is vite's injected
 * `import.meta.hot` rather than a build-time `define`, which the running dev
 * server may not apply to this module.
 */
function devEngineOrigin(): string | null {
  if (typeof location === 'undefined' || !import.meta.hot) return null;
  const configured = import.meta.env?.VITE_ENGINE_PORT;
  const port = typeof configured === 'string' && configured ? configured : '8787';
  if (location.port === port) return null;
  const protocol = location.protocol === 'https:' ? 'https:' : 'http:';
  return `${protocol}//${location.hostname || '127.0.0.1'}:${port}`;
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

class HttpTransport extends BaseTransport {
  readonly mode = 'web' as const;
  private source: EventSource | null = null;
  private probe: ReturnType<typeof setInterval> | null = null;
  private probeInFlight = false;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private healthInFlight = false;
  private base: string;

  constructor(base = '/engine') {
    super();
    this.base = base;
  }

  async start(): Promise<EngineInfo> {
    try {
      const info = await this.call<EngineInfo>('engine.info', {});
      this.info = info;
      this.setStatus('ready');
      this.openEvents();
      this.startHealthCheck();
      return info;
    } catch (error) {
      this.setStatus('offline');
      this.startProbe();
      throw error;
    }
  }

  async call<T>(method: RpcMethodName, params: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs ?? 120_000);
    let response: Response;
    try {
      response = await fetch(`${this.base}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, params }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw new RpcError('offline', `engine responded ${response.status}`);
    const payload = (await response.json()) as
      | { ok: true; result: T }
      | { ok: false; error: { code: string; message: string; details?: { hintKey?: string } } };
    if (!payload.ok) {
      throw new RpcError(payload.error.code, payload.error.message, payload.error.details?.hintKey);
    }
    return payload.result;
  }

  stop(): void {
    this.source?.close();
    this.source = null;
    if (this.probe) clearInterval(this.probe);
    this.probe = null;
    this.probeInFlight = false;
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
  }

  private openEvents(): void {
    if (this.source || typeof EventSource === 'undefined') return;
    this.source = new EventSource(this.eventsUrl());
    this.source.onmessage = (message) => {
      try {
        this.emitEvent(JSON.parse(message.data) as EngineEvent);
      } catch {
        // ignore malformed frames
      }
    };
    this.source.onerror = () => {
      this.setStatus('offline');
      this.source?.close();
      this.source = null;
      this.startProbe();
    };
  }

  /**
   * Vite's dev proxy buffers `text/event-stream`, so progress frames are read
   * straight from the engine origin when the dev server injected one.
   */
  private eventsUrl(): string {
    const direct = devEngineOrigin();
    if (direct) return `${direct}/events`;
    return `${this.base}/events`;
  }

  private startProbe(): void {
    if (this.probe) return;
    this.probe = setInterval(() => {
      if (this.probeInFlight) return;
      this.probeInFlight = true;
      void this.call<EngineInfo>('engine.info', {}, 2500)
        .then((info) => {
          this.info = info;
          this.setStatus('ready');
          this.openEvents();
          this.startHealthCheck();
          if (this.probe) clearInterval(this.probe);
          this.probe = null;
        })
        .catch(() => this.setStatus('offline'))
        .finally(() => { this.probeInFlight = false; });
    }, 3000);
  }

  private startHealthCheck(): void {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(() => {
      if (this.healthInFlight || this.status !== 'ready') return;
      this.healthInFlight = true;
      void this.call<EngineInfo>('engine.info', {}, 2500)
        .then((info) => {
          this.info = info;
          this.setStatus('ready');
        })
        .catch(() => {
          this.setStatus('offline');
          this.source?.close();
          this.source = null;
          this.startProbe();
        })
        .finally(() => { this.healthInFlight = false; });
    }, 5000);
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
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
  readonly mode = 'tauri' as const;
  private pending = new Map<string, Pending>();
  private unlisten: (() => void) | null = null;
  private ready: Promise<EngineInfo> | null = null;
  private sidecarReady: Promise<void> | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private healthInFlight = false;
  private embeddedJobs = new Map<string, JobSnapshot>();
  private sidecarJobs = new Map<string, JobSnapshot>();
  private embeddedArtifactPaths = new Map<string, string>();
  private embeddedArtifactRoots = new Map<string, string>();
  private embeddedQueue: Array<{ request: JobRequest; inputs: ResolvedInput[] }> = [];
  private embeddedActive = 0;
  private embeddedConcurrency = 1;
  private tempDir: string | null = null;
  private systemFontCandidates: Promise<string[]> | null = null;
  private systemFontBytes = new Map<string, Promise<Uint8Array | null>>();

  async start(options?: { concurrency?: number }): Promise<EngineInfo> {
    if (this.ready) return this.ready;
    this.embeddedConcurrency = Math.max(1, Math.trunc(options?.concurrency ?? 1));
    this.ready = this.bootstrap(options?.concurrency);
    return this.ready;
  }

  private async bootstrap(concurrency?: number): Promise<EngineInfo> {
    const bridge = await engineBridge();
    const host = await bridge.invoke<{ platform: string; defaultOutputDir: string; defaultTempDir: string }>('desktop_runtime_info');
    this.embeddedConcurrency = Math.max(1, Math.trunc(concurrency ?? 1));
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
      features: { rasterizer: 'none', imageCodec: false, cjkFont: null, busy: false },
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
      const bridge = await engineBridge();
      bytes = Uint8Array.from(await bridge.invoke<number[]>('read_file_bytes', { path: file.path }));
    } else if (file.dataBase64) {
      bytes = decodeBase64(file.dataBase64);
    } else {
      throw new RpcError('bad_request', `${file.name || '文件'} 缺少路径或内容`);
    }
    return { id: file.id, name: file.name, path: file.path ?? null, bytes };
  }

  private async tryEmbeddedFileRpc<T>(method: RpcMethodName, params: Record<string, unknown>): Promise<{ handled: boolean; result?: T }> {
    if (!canRunEmbeddedRpc({ method, params }) || !params.file || typeof params.file !== 'object') return { handled: false };
    try {
      const input = await this.resolveInput(params.file as FileRef);
      const workerParams = method === 'page.thumbs' ? { ...params, workerSrc: pdfWorkerUrl } : params;
      const reply = await callEmbeddedRpc(method, workerParams, { inputs: [input] });
      return { handled: reply.handled, result: reply.result as T };
    } catch (error) {
      if (error instanceof RpcError && error.code === 'encrypted_document') throw error;
      // The compatibility engine retains the established handling for inputs
      // or documents that the embedded Worker cannot process.
      return { handled: false };
    }
  }

  private async scanInvoices<T>(params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const bridge = await engineBridge();
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

    const files: InvoiceScanEntry[] = [];
    const skipped = [...listing.skipped];
    const emptyFields = (): InvoiceScanEntry['fields'] => ({ date: '', seller: '', buyer: '', invoiceNo: '', amount: '', type: '' });
    for (const [index, candidate] of listing.files.entries()) {
      let loaded: { bytes: number[]; currentSizeBytes: number; changedWhileReading: boolean };
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
          files.push({ ...candidate, sizeBytes: 0, sha256: '', pageCount: null, extractedText: '', recognition: 'failed', fields: emptyFields(), error: message });
        }
        continue;
      }
      const bytes = Uint8Array.from(loaded.bytes);
      if (bytes.byteLength > 100 * 1024 * 1024) {
        skipped.push({ relativePath: candidate.relativePath, reason: '扫描期间文件发生变化或超过大小上限' });
        continue;
      }
      const input: ResolvedInput = { id: `invoice-${index}`, name: candidate.name, path: candidate.path, bytes };
      let embedded;
      try {
        embedded = await callEmbeddedRpc('invoice.scan', {
          file: { ...candidate, changedWhileReading: loaded.changedWhileReading },
        }, { inputs: [input] });
      } catch {
        // Keep MuPDF's exact text extraction and error behavior as a compatibility fallback.
        return this.callSidecar<T>('invoice.scan', params, timeoutMs);
      }
      if (!embedded.handled) return this.callSidecar<T>('invoice.scan', params, timeoutMs);
      const analyzed = embedded.result as { entry?: InvoiceScanEntry; skipped?: InvoiceScanResult['skipped'][number] } | undefined;
      if (analyzed?.entry) files.push(analyzed.entry);
      if (analyzed?.skipped) skipped.push(analyzed.skipped);
    }
    return {
      sourceDirectory: listing.sourceDirectory,
      scannedAt: Date.now(),
      files,
      skipped,
      warnings: ['ocr-unavailable', ...(listing.exceeded ? ['scan-limit-reached'] : [])],
    } as T;
  }

  private async startSidecar(): Promise<void> {
    if (this.sidecarReady) return this.sidecarReady;
    this.sidecarReady = (async () => {
      const bridge = await engineBridge();
      this.unlisten = await bridge.listen('engine://line', (payload) => this.onLine(String(payload)));
      const raw = await bridge.invoke<string>('engine_start', { concurrency: this.embeddedConcurrency });
      let frame: { id?: unknown; result?: EngineInfo };
      try {
        frame = JSON.parse(raw) as { id?: unknown; result?: EngineInfo };
      } catch {
        throw new RpcError('offline', '引擎启动握手不是有效 JSON');
      }
      if (frame.id !== 'ready' || !frame.result || typeof frame.result !== 'object') {
        throw new RpcError('offline', '引擎启动握手格式不正确');
      }
      this.info = frame.result;
      if (this.tempDir) {
        const id = nextId();
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.pending.delete(id);
            reject(new RpcError('offline', '应用临时目录设置超时'));
          }, 10_000);
          this.pending.set(id, {
            resolve: () => { clearTimeout(timer); resolve(); },
            reject: (error) => { clearTimeout(timer); reject(error); },
          });
          bridge.invoke('engine_write', {
            line: JSON.stringify({ jsonrpc: '2.0', id, method: 'engine.setTempDir', params: { dir: this.tempDir } }),
          }).catch((error) => {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(error);
          });
        });
      }
      this.startHealthCheck();
    })().catch((error) => {
      this.unlisten?.();
      this.unlisten = null;
      this.sidecarReady = null;
      throw error;
    });
    return this.sidecarReady;
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }
    if (frame.event) {
      const event = frame as unknown as EngineEvent;
      if (event.event === 'job.updated') this.sidecarJobs.set(event.job.id, event.job);
      this.emitEvent(event);
      return;
    }
    const id = String(frame.id ?? '');
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (frame.error) {
      const error = frame.error as { code: string; message: string; details?: { hintKey?: string } };
      pending.reject(new RpcError(error.code, error.message, error.details?.hintKey));
    } else {
      pending.resolve(frame.result);
    }
  }

  async call<T>(method: RpcMethodName, params: Record<string, unknown>, timeoutMs = 120_000): Promise<T> {
    if (method === 'engine.info') return this.localInfo<T>();
    if (method === 'engine.ping') {
      if (this.sidecarReady) return this.callSidecar<T>(method, params, timeoutMs);
      return { pong: Date.now() } as T;
    }
    if (method === 'engine.setTempDir') {
      this.tempDir = typeof params.dir === 'string' && params.dir.trim() ? params.dir.trim() : null;
      if (this.info) this.info = { ...this.info, tempDir: this.tempDir ?? this.info.defaultTempDir };
      if (this.sidecarReady) {
        const sidecar = await this.callSidecar<{ tempDir: string }>(method, { dir: this.tempDir });
        if (this.info) this.info = { ...this.info, tempDir: sidecar.tempDir };
        return sidecar as T;
      }
      return { tempDir: this.tempDir ?? this.info?.defaultTempDir ?? '' } as T;
    }
    if (method === 'tools.list') return TOOL_LIST as T;
    if (method === 'temp.stat' || method === 'temp.clean') {
      if (!this.info) await this.start();
      const bridge = await engineBridge();
      const root = this.tempDir ?? this.info?.defaultTempDir ?? '';
      if (method === 'temp.stat') return await bridge.invoke('temp_usage', { root }) as T;
      const protectJobs = [...this.embeddedJobs.values(), ...this.sidecarJobs.values()]
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
        const bridge = await engineBridge();
        return await bridge.invoke<DirListing>('browse_directories', {
          path: typeof params.path === 'string' ? params.path : null,
        }) as T;
      } catch {
        // Preserve the compatibility engine's established directory errors.
      }
    }
    if (method === 'page.thumbs' || method === 'file.probe' || method === 'page.list') {
      const embedded = await this.tryEmbeddedFileRpc<T>(method, params);
      if (embedded.handled) return embedded.result as T;
    }
    if (method === 'file.bytes' && params.file && typeof params.file === 'object') {
      const file = params.file as FileRef;
      if (file.path) {
        const bridge = await engineBridge();
        const bytes = Uint8Array.from(await bridge.invoke<number[]>('read_file_bytes', { path: file.path }));
        return { dataBase64: encodeBase64(bytes), name: file.name } as T;
      }
      if (file.dataBase64) return { dataBase64: file.dataBase64, name: file.name } as T;
    }
    if (method === 'shell.reveal' && typeof params.path === 'string') {
      const bridge = await engineBridge();
      await bridge.invoke('open_path', { path: params.path, reveal: params.open !== true });
      return { revealed: true, path: params.path } as T;
    }
    if (method === 'shell.print' && typeof params.path === 'string') {
      const bridge = await engineBridge();
      try {
        return await bridge.invoke<T>('print_file', { path: params.path });
      } catch (error) {
        throw new RpcError('bad_request', String(error));
      }
    }
    if (method === 'invoice.scan') return this.scanInvoices<T>(params, timeoutMs);
    if (method === 'invoice.archive' && params && typeof params === 'object') {
      const bridge = await engineBridge();
      try {
        return await bridge.invoke<T>('invoice_archive', { input: params });
      } catch (error) {
        throw new RpcError('bad_request', String(error));
      }
    }
    if (method === 'invoice.undo' && typeof params.archiveId === 'string') {
      const bridge = await engineBridge();
      try {
        return await bridge.invoke<T>('invoice_undo', { archiveId: params.archiveId });
      } catch (error) {
        throw new RpcError('bad_request', String(error));
      }
    }
    if (method === 'file.write' && typeof params.dataBase64 === 'string') {
      const bytes = decodeBase64(params.dataBase64);
      const bridge = await engineBridge();
      return bridge.invoke<T>('write_output_file', {
        dir: String(params.dir ?? ''),
        name: String(params.name ?? 'output.txt'),
        bytes: Array.from(bytes),
      });
    }
    if (method === 'job.list' && !this.sidecarReady) return [...this.embeddedJobs.values()] as T;
    if (method === 'tool.run' && canRunEmbeddedRpc({ method, params })) {
      const tool = String(params.tool ?? '');
      let runtimeData: Record<string, unknown> | undefined;
      if (tool === 'dns-lookup') {
        try {
          const bridge = await engineBridge();
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
          const bridge = await engineBridge();
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
      if (canRunEmbeddedRpc({ method, params })) return this.submitEmbeddedJob<T>(params.job as JobRequest);
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
        }
        return { cancelled: true } as T;
      }
      if (job) return { cancelled: false } as T;
      if (!this.sidecarReady) return { cancelled: false } as T;
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
      const remaining = jobIds?.filter((id) => !removed.includes(id));
      if (jobIds && !remaining?.length) return { removed: removed.length } as T;
      if (!this.sidecarReady) return { removed: removed.length } as T;
      const result = await this.callSidecar<{ removed: number }>('job.clear', jobIds ? { jobIds: remaining } : {});
      return { removed: result.removed + removed.length } as T;
    }
    if (method === 'file.write' && typeof params.jobId === 'string' && typeof params.artifactId === 'string') {
      const artifactKey = `${params.jobId}:${params.artifactId}`;
      const staged = this.embeddedArtifactPaths.get(artifactKey);
      const tempRoot = this.embeddedArtifactRoots.get(artifactKey);
      if (staged) {
        const bridge = await engineBridge();
        const path = await bridge.invoke<string>('copy_staged_artifact', {
          from: staged,
          dir: String(params.dir ?? ''),
          name: String(params.name ?? ''),
          tempRoot: tempRoot ?? this.tempDir ?? this.info?.defaultTempDir ?? '',
        });
        return { path, name: path.split(/[\\/]/).pop() } as T;
      }
    }
    return this.callSidecar<T>(method, params, timeoutMs);
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
        this.embeddedJobs.delete(request.id);
        if (this.status !== 'ready') await this.start();
        await this.callSidecar('job.submit', { job: request });
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
          const staged = await bridge.invoke<{ stagedPath: string; outputPath?: string; name: string }>('stage_job_artifact', {
            jobId: request.id,
            name: artifact.name,
            bytes: Array.from(artifact.bytes),
            outputDir: request.output?.dir ?? null,
            tempRoot,
          });
          snapshotArtifact.name = staged.name;
          snapshotArtifact.path = staged.outputPath ?? staged.stagedPath;
          this.embeddedArtifactPaths.set(`${request.id}:${snapshotArtifact.id}`, staged.stagedPath);
          this.embeddedArtifactRoots.set(`${request.id}:${snapshotArtifact.id}`, tempRoot);
        }
      }
      this.publishEmbeddedJob(final);
    } catch (error) {
      const current = this.embeddedJobs.get(request.id);
      if (!current) return;
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
          markdownAssets[`${input.id}\0${source}`] = Uint8Array.from(
            await bridge.invoke<number[]>('read_file_bytes', { path }),
          );
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

  private async callSidecar<T = unknown>(method: RpcMethodName, params: Record<string, unknown>, timeoutMs = 120_000): Promise<T> {
    if (this.status !== 'ready') await this.start();
    await this.startSidecar();
    const bridge = await engineBridge();
    const id = nextId();
    const line = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending.delete(id)) reject(new RpcError('offline', `${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          if (method === 'job.list') {
            const combined = [...this.embeddedJobs.values(), ...(value as JobSnapshot[])];
            const unique = new Map(combined.map((job) => [job.id, job]));
            resolve([...unique.values()] as T);
          } else {
            resolve(value as T);
          }
        },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
      bridge.invoke('engine_write', { line }).catch((error) => {
        clearTimeout(timeout);
        if (this.pending.delete(id)) reject(new RpcError('offline', String(error)));
      });
    });
  }

  stop(): void {
    if (this.sidecarReady) void engineBridge().then((bridge) => bridge.invoke('engine_stop')).catch(() => undefined);
    this.unlisten?.();
    this.unlisten = null;
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    this.pending.clear();
    this.ready = null;
    this.sidecarReady = null;
  }

  private startHealthCheck(): void {
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

/**
 * Desktop uses the stdio sidecar; the browser talks to a locally started engine.
 * `force` lets the caller retry with the other transport when IPC is unavailable.
 */
export function getTransport(force?: 'http' | 'tauri'): Transport {
  if (singleton && !force) return singleton;
  const useTauri = force ? force === 'tauri' : isTauri();
  singleton = useTauri ? new TauriTransport() : new HttpTransport();
  return singleton;
}

export function resetTransport(): void {
  singleton?.stop();
  singleton = null;
}
