import type { EngineEvent, EngineInfo, RpcMethodName } from 'core';
import { engineBridge, isTauri } from './tauri.ts';

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

/** Injected by vite for browser development; absent in the Tauri build. */
declare const __ENGINE_DIRECT__: string | undefined;

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
    if (typeof __ENGINE_DIRECT__ === 'string' && __ENGINE_DIRECT__) return `${__ENGINE_DIRECT__}/events`;
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

class TauriTransport extends BaseTransport {
  readonly mode = 'tauri' as const;
  private pending = new Map<string, Pending>();
  private unlisten: (() => void) | null = null;
  private ready: Promise<EngineInfo> | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private healthInFlight = false;

  async start(options?: { concurrency?: number }): Promise<EngineInfo> {
    if (this.ready) return this.ready;
    this.ready = this.bootstrap(options?.concurrency);
    return this.ready;
  }

  private async bootstrap(concurrency?: number): Promise<EngineInfo> {
    const bridge = await engineBridge();
    const unlisten = await bridge.listen('engine://line', (payload) => {
      this.onLine(String(payload));
    });
    this.unlisten = unlisten;
    // The host waits for and returns the sidecar's first ready frame. This
    // keeps startup behind an explicit engine handshake instead of racing a
    // second RPC against a process that may still be initializing.
    const raw = await bridge.invoke<string>('engine_start', { concurrency: concurrency ?? 1 });
    let frame: { id?: unknown; result?: EngineInfo };
    try {
      frame = JSON.parse(raw) as { id?: unknown; result?: EngineInfo };
    } catch {
      throw new RpcError('offline', '引擎启动握手不是有效 JSON');
    }
    if (frame.id !== 'ready' || !frame.result || typeof frame.result !== 'object') {
      throw new RpcError('offline', '引擎启动握手格式不正确');
    }
    const info = frame.result;
    this.info = info;
    this.setStatus('ready');
    this.startHealthCheck();
    return info;
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
      this.emitEvent(frame as unknown as EngineEvent);
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
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      bridge.invoke('engine_write', { line }).catch((error) => {
        clearTimeout(timeout);
        if (this.pending.delete(id)) reject(new RpcError('offline', String(error)));
      });
    });
  }

  stop(): void {
    this.unlisten?.();
    this.unlisten = null;
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    this.pending.clear();
    this.ready = null;
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
