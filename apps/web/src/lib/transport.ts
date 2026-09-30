import type { DirListing, EngineInfo, FileRef, JobRequest, JobSnapshot, RpcMethodName } from 'core';
import { PROTOCOL_VERSION, TOOL_LIST } from './core-bindings.ts';
import type { ResolvedInput } from './engine-types.ts';
import { callEmbeddedRpc, configureEmbeddedWorkerPool, embeddedWorkerCount, shutdownEmbeddedWorkerPool } from './embedded-engine.ts';
import { EmbeddedJobRunner, textToolRuntimeData } from './embedded-jobs.ts';
import { scanInvoices as scanInvoicesInWeb } from './invoice-scan.ts';
import { engineBridge, isTauri } from './tauri.ts';
import { BaseTransport, decodeBase64, encodeBase64, RpcError, type Transport, type TransportStatus } from './transport-shared.ts';
import { APP_VERSION } from './version.ts';

export { RpcError } from './transport-shared.ts';
export type { Transport, TransportStatus } from './transport-shared.ts';

let counter = 0;
const nextId = (): string => `r${Date.now().toString(36)}${(counter += 1)}`;

class TauriTransport extends BaseTransport {
  readonly mode: 'web' | 'tauri' = isTauri() ? 'tauri' : 'web';
  private ready: Promise<EngineInfo> | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private healthInFlight = false;
  private tempDir: string | null = null;
  private jobs = new EmbeddedJobRunner({
    resolveInput: (file: FileRef) => this.resolveInput(file),
    publish: (snapshot) => this.publishJobEvent(snapshot),
    tempDir: () => this.tempDir,
    defaultTempDir: () => this.info?.defaultTempDir ?? null,
    ensureRuntime: async () => this.info ?? await this.start(),
  });

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
    this.jobs.configure(options?.concurrency);
    configureEmbeddedWorkerPool(this.jobs.size);
    this.ready = this.bootstrap(options?.concurrency);
    return this.ready;
  }

  private async bootstrap(concurrency?: number): Promise<EngineInfo> {
    const platform = typeof navigator !== 'undefined' ? navigator.platform : 'unknown';
    const bridge = isTauri() ? await engineBridge() : null;
    const host = bridge
      ? await bridge.invoke<{ platform: string; defaultOutputDir: string; defaultTempDir: string }>('desktop_runtime_info')
      : { platform, defaultOutputDir: '', defaultTempDir: '' };
    this.jobs.configure(concurrency);
    configureEmbeddedWorkerPool(this.jobs.size);
    // Self-check values: page rendering is provided by the host adapter
    // (PDF.js in the worker), canvas codecs serve image transcoding, and
    // host-discovered fonts cover CJK.
    const fontCandidates = bridge
      ? await bridge.invoke<string[]>('system_font_candidates').catch(() => [] as string[])
      : [];
    const info: EngineInfo = {
      name: '@potools/engine',
      version: APP_VERSION,
      protocol: PROTOCOL_VERSION,
      platform: host.platform,
      nodeVersion: 'Web Worker',
      pid: 0,
      defaultOutputDir: host.defaultOutputDir,
      tempDir: this.tempDir ?? host.defaultTempDir,
      defaultTempDir: host.defaultTempDir,
      features: {
        rasterizer: 'host',
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
    const reply = await callEmbeddedRpc(method, params, { inputs: [input] });
    if (!reply.handled) throw new RpcError('unsupported', `${method} 不支持此文件或当前浏览器环境`);
    return { handled: true, result: reply.result as T };
  }

  private async scanInvoices<T>(params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const bridge = await this.requireNativeHost();
    try {
      return await scanInvoicesInWeb(bridge.invoke.bind(bridge), params, embeddedWorkerCount()) as T;
    } catch (error) {
      const message = String(error);
      throw new RpcError(message.includes('无法访问来源目录') ? 'unreadable_file' : 'bad_request', message);
    }
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
      const protectJobs = this.jobs.list()
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
    if (method === 'job.list') return this.jobs.list() as T;
    if (method === 'tool.run') {
      const tool = String(params.tool ?? '');
      const options = (params.options ?? {}) as Record<string, unknown>;
      const runtimeData = await textToolRuntimeData(tool, options);
      if (isTauri()) {
        const bridge = await this.requireNativeHost();
        const native = await bridge.invoke<{
          handled: boolean;
          result?: T;
          error?: { code?: string; message?: string; hintKey?: string } | null;
        }>('engine_run_text_tool', {
          tool,
          options: params.options ?? {},
          locale: (params.globals as { locale?: string } | undefined)?.locale ?? 'zh-CN',
          namePattern: params.namePattern,
          runtimeData,
        });
        if (native.error) {
          throw new RpcError(native.error.code ?? 'internal', native.error.message ?? 'Rust 引擎执行失败', native.error.hintKey);
        }
        if (native.handled) return native.result as T;
      }
      const embedded = await callEmbeddedRpc(method, params, { runtimeData });
      if (embedded.handled) return embedded.result as T;
    }
    if (method === 'job.submit' && params.job && typeof params.job === 'object') {
      return this.jobs.submit<T>(params.job as JobRequest);
    }
    if (method === 'job.cancel') {
      return { cancelled: await this.jobs.cancel(String(params.jobId ?? '')) } as T;
    }
    if (method === 'job.clear') {
      const jobIds = params.jobIds as string[] | undefined;
      return { removed: this.jobs.clear(jobIds) } as T;
    }
    if (method === 'file.write' && typeof params.jobId === 'string' && typeof params.artifactId === 'string') {
      const staged = await this.jobs.stagedOutput<T>(
        String(params.jobId),
        String(params.artifactId),
        String(params.dir ?? ''),
        String(params.name ?? ''),
      );
      if (staged) return staged;
    }
    return this.callSidecar<T>(method, params);
  }

  private publishJobEvent(snapshot: JobSnapshot): void {
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
