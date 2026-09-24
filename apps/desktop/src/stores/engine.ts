import { create } from 'zustand';
import type { EngineInfo, JobRequest, RpcMethodName } from 'core';
import { getTransport, resetTransport, type TransportStatus } from '../lib/transport.ts';
import { isTauri } from '../lib/tauri.ts';
import '../lib/devdebug.ts';
import { useSettings } from '../lib/settings.ts';

interface EngineState {
  status: TransportStatus;
  info: EngineInfo | null;
  error: string | null;
  started: boolean;
  /** Keeps the startup screen up while a manual reconnect is in flight. */
  reconnecting: boolean;
  boot: () => Promise<void>;
  reconnect: () => Promise<void>;
  /** Pushes the saved scratch folder into a running engine. */
  syncTempDir: () => Promise<void>;
  call: <T>(method: RpcMethodName, params?: Record<string, unknown>) => Promise<T>;
}

/** Desktop settings travel with every job so the engine stays stateless. */
function applyJobDefaults(job: JobRequest): JobRequest {
  const settings = useSettings.getState();
  return {
    ...job,
    namePattern: job.namePattern ?? settings.namePattern,
    globals: {
      fontPath: settings.fontPath,
      locale: settings.locale,
      ...job.globals,
    },
    output: {
      // An unset preference means "use the platform folder the engine reports".
      dir: settings.outputDir || useEngine.getState().info?.defaultOutputDir || null,
      // Native mode reads artifacts from staged files, so keeping a second
      // base64 copy in the Node heap is unnecessary.
      wantBytes: !isTauri(),
      ...job.output,
    },
  };
}

export const useEngine = create<EngineState>((set, get) => ({
  status: 'connecting',
  info: null,
  error: null,
  started: false,
  reconnecting: false,

  boot: async () => {
    if (get().started) return;
    set({ started: true });
    const transport = getTransport();
    transport.onStatus((status) => set({ status }));
    try {
      const info = await transport.start({ concurrency: useSettings.getState().concurrency });
      set({ info, error: null });
      await get().syncTempDir();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A packaged shell can still fail to expose IPC (e.g. an untrusted dev
      // origin); fall back to a locally running engine instead of a dead UI.
      if (transport.mode === 'tauri') {
        resetTransport();
        const http = getTransport('http');
        http.onStatus((status) => set({ status }));
        try {
          const info = await http.start();
          set({ info, error: null });
          await get().syncTempDir();
          return;
        } catch {
          // fall through and report the original failure
        }
      }
      set({ error: message, status: 'offline' });
    }
  },

  reconnect: async () => {
    // The state above can coalesce into one paint, so the screen is held by an
    // explicit flag: a localhost handshake alone would be over in milliseconds.
    const startedAt = Date.now();
    resetTransport();
    set({ started: false, info: null, status: 'connecting', reconnecting: true });
    try {
      await get().boot();
      const elapsed = Date.now() - startedAt;
      if (elapsed < 700) await new Promise((resolve) => setTimeout(resolve, 700 - elapsed));
    } finally {
      set({ reconnecting: false });
    }
  },

  syncTempDir: async () => {
    const info = get().info;
    if (!info) return;
    const dir = useSettings.getState().tempDir;
    if ((dir || info.defaultTempDir) === info.tempDir) return;
    try {
      const next = await get().call<{ tempDir: string }>('engine.setTempDir', { dir });
      set({ info: { ...info, tempDir: next.tempDir } });
    } catch {
      // The engine may already be offline; the next boot applies the setting.
    }
  },

  call: async <T>(method: RpcMethodName, params: Record<string, unknown> = {}): Promise<T> => {
    const transport = getTransport();
    if (transport.mode !== 'tauri' && transport.status !== 'ready') {
      await transport.start().catch(() => undefined);
    }
    const payload =
      method === 'job.submit' && params.job
        ? { ...params, job: applyJobDefaults(params.job as JobRequest) }
        : params;
    const result = await transport.call<T>(method, payload);
    if (method === 'engine.info') set({ info: result as unknown as EngineInfo });
    return result;
  },
}));

window.__potoolsEngine = <T>(method: RpcMethodName, params: Record<string, unknown> = {}) =>
  useEngine.getState().call<T>(method, params);

export function transportMode(): 'web' | 'tauri' {
  return getTransport().mode;
}

export function rpcErrorMessage(error: unknown): { message: string; hintKey?: string; code: string } {
  if (error && typeof error === 'object' && 'code' in error) {
    const rpc = error as { code: string; message: string; hintKey?: string };
    return { code: rpc.code, message: rpc.message, hintKey: rpc.hintKey };
  }
  return {
    code: 'internal',
    message: error instanceof Error ? error.message : String(error),
  };
}
