import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { RpcMethodName } from '@potools/core';
import { toJobError } from '../errors.ts';
import { logger } from '../logger.ts';
import type { Engine } from '../rpc.ts';

const MAX_BODY = 512 * 1024 * 1024;

export interface HttpOptions {
  port: number;
  host?: string;
  token?: string | null;
  allowedOrigins?: string[];
}

/**
 * Dev/browser transport. Bound to loopback and gated by an origin allow-list so
 * a random web page cannot drive the sidecar; the Tauri build uses stdio.
 */
export function serveHttp(engine: Engine, options: HttpOptions): { close(): void } {
  const host = options.host ?? '127.0.0.1';
  const origins = options.allowedOrigins ?? [];

  const server = createServer((request, response) => {
    void handle(request, response);
  });

  server.on('error', (error) => logger.error('http server error', { error: String(error) }));
  server.listen(options.port, host, () => {
    logger.info('engine ready on http', { host, port: options.port, pid: process.pid });
  });

  return { close: () => server.close() };

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const origin = typeof request.headers.origin === 'string' ? request.headers.origin : undefined;

    if (origin && origins.length && !origins.includes('*') && !origins.includes(origin)) {
      reply(response, 403, { error: 'origin not allowed' }, origin);
      return;
    }
    if (options.token) {
      const provided = request.headers['x-engine-token'] ?? url.searchParams.get('token');
      if (provided !== options.token) {
        reply(response, 401, { error: 'bad token' }, origin);
        return;
      }
    }

    if (request.method === 'OPTIONS') {
      response.writeHead(204, corsHeaders(origin));
      response.end();
      return;
    }

    if (url.pathname === '/health') {
      reply(response, 200, engine.info(), origin);
      return;
    }

    if (url.pathname === '/events') {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        ...corsHeaders(origin),
      });
      response.write(': open\n\n');
      const unsubscribe = engine.manager.on((event) => {
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      });
      const heartbeat = setInterval(() => response.write(': ping\n\n'), 15000);
      request.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
      return;
    }

    if (url.pathname === '/rpc' && request.method === 'POST') {
      try {
        const body = await readBody(request);
        const payload = JSON.parse(body) as { method: RpcMethodName; params?: Record<string, unknown> };
        const result = await engine.call(payload.method, payload.params ?? {});
        reply(response, 200, { ok: true, result }, origin);
      } catch (error) {
        reply(response, 200, { ok: false, error: toJobError(error) }, origin);
      }
      return;
    }

    reply(response, 404, { error: 'not found' }, origin);
  }
}

function corsHeaders(origin?: string): Record<string, string> {
  return {
    'access-control-allow-origin': origin ?? '*',
    'access-control-allow-headers': 'content-type, x-engine-token',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  };
}

function reply(response: ServerResponse, status: number, body: unknown, origin?: string): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...corsHeaders(origin),
  });
  response.end(payload);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        rejectBody(new Error('payload too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    request.on('error', rejectBody);
  });
}
