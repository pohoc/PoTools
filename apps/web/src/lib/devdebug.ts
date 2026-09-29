import type { RpcMethodName } from 'core';

declare global {
  interface Window {
    /** Escape hatch that lets browser checks drive the engine RPC. */
    __potoolsEngine?: <T>(method: RpcMethodName, params?: Record<string, unknown>) => Promise<T>;
  }
}

export {};
