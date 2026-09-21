import { createInterface } from 'node:readline';
import type { EngineEvent, RpcRequest, RpcResponse } from '@potools/core';
import { toJobError } from '../errors.ts';
import { logger } from '../logger.ts';
import type { Engine } from '../rpc.ts';

/**
 * Newline-delimited JSON-RPC over stdin/stdout — the transport the Tauri host
 * uses. Nothing except protocol frames may reach stdout in this mode.
 */
export function serveStdio(engine: Engine): void {
  const write = (frame: unknown) => {
    process.stdout.write(`${JSON.stringify(frame)}\n`);
  };

  const unsubscribe = engine.manager.on((event: EngineEvent) => write(event));

  write({ jsonrpc: '2.0', id: 'ready', result: engine.info() });
  logger.info('engine ready on stdio', { pid: process.pid });

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let request: RpcRequest;
    try {
      request = JSON.parse(trimmed) as RpcRequest;
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: 'bad_request', message: 'invalid JSON line' } });
      return;
    }
    void respond(request);
  });
  rl.on('close', () => {
    unsubscribe();
    process.exit(0);
  });

  async function respond(request: RpcRequest): Promise<void> {
    const response: Record<string, unknown> = { jsonrpc: '2.0', id: request.id };
    try {
      response.result = await engine.call(
        request.method as never,
        request.params as unknown as Record<string, unknown>,
      );
    } catch (error) {
      response.error = toJobError(error);
    }
    write(response);
  }
}

export type { RpcResponse };
