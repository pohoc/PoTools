#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import type { RpcMethodName } from '@potools/core';
import { hijackConsole, logger, setLogLevel, type LogLevel } from './logger.ts';
import { createEngine } from './rpc.ts';
import { serveStdio } from './serve/stdio.ts';
import { serveHttp } from './serve/http.ts';
import { toJobError } from './errors.ts';

hijackConsole();

const HELP = `PoTools engine

Usage:
  engine serve --stdio                     JSON-RPC over stdin/stdout (Tauri)
  engine serve --http [--port 8787]        JSON-RPC over loopback HTTP + SSE
  engine selfcheck [--json]                report available capabilities
  engine call <method> [--params <json>] [--params-file <path>] [--out <path>]
  engine probe <file.pdf>                  page count and metadata

Options:
  --concurrency <n>   parallel jobs (default 2)
  --token <secret>   require x-engine-token on the HTTP transport
  --allow-origin <o>  repeatable origin allow-list for the HTTP transport
  --log <level>      debug | info | warn | error
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      stdio: { type: 'boolean', default: false },
      http: { type: 'boolean', default: false },
      port: { type: 'string', default: '8787' },
      host: { type: 'string', default: '127.0.0.1' },
      token: { type: 'string' },
      'allow-origin': { type: 'string', multiple: true, default: [] },
      concurrency: { type: 'string', default: '1' },
      log: { type: 'string', default: 'info' },
      json: { type: 'boolean', default: false },
      params: { type: 'string' },
      'params-file': { type: 'string' },
      out: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });

  setLogLevel(values.log as LogLevel);
  if (values.help || positionals.length === 0) {
    process.stdout.write(HELP);
    return;
  }

  const command = positionals[0] as string;
  const engine = await createEngine({ concurrency: Number(values.concurrency) || 2 });

  if (command === 'serve') {
    // Staged artifacts pile up across runs; sweep anything older than the TTL.
    const ttlDays = Number(process.env.POTOOLS_TEMP_TTL_DAYS ?? 7);
    if (ttlDays > 0) {
      const { cleanTemp } = await import('./lib/temp.ts');
      const { TEMP_ROOT } = await import('./lib/files.ts');
      const cleaned = await cleanTemp(TEMP_ROOT, { olderThanDays: ttlDays, keepJobs: 1 }).catch(() => null);
      if (cleaned?.removedJobs) {
        logger.info('swept stale temp jobs', {
          removed: cleaned.removedJobs,
          freedBytes: cleaned.freedBytes,
          ttlDays,
        });
      }
    }
    if (values.http) {
      serveHttp(engine, {
        port: Number(values.port),
        host: values.host,
        token: values.token ?? null,
        allowedOrigins: (values['allow-origin'] as string[]) ?? [],
      });
      return;
    }
    serveStdio(engine);
    return;
  }

  if (command === 'selfcheck') {
    const report = {
      ok: true,
      ...engine.info(),
      temp: process.env.POTOOLS_TEMP ?? null,
      node: process.version,
    };
    process.stdout.write(`${JSON.stringify(report, null, values.json ? 0 : 2)}\n`);
    return;
  }

  if (command === 'call') {
    const method = positionals[1] as RpcMethodName;
    if (!method) throw new Error('missing method');
    const raw = values['params-file']
      ? await readFile(String(values['params-file']), 'utf8')
      : (values.params ?? '{}');
    const result = await engine.call(method, JSON.parse(raw));
    const payload = JSON.stringify(result, null, 2);
    if (values.out) await writeFile(values.out, payload);
    else process.stdout.write(`${payload}\n`);
    return;
  }

  if (command === 'probe') {
    const path = positionals[1];
    if (!path) throw new Error('missing file path');
    const result = await engine.call('file.probe', { file: { id: 'p1', name: path, path } });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  process.stderr.write(`unknown command: ${command}\n\n${HELP}`);
  process.exitCode = 2;
}

main().catch((error) => {
  const jobError = toJobError(error);
  logger.error('engine exited with error', jobError);
  process.exitCode = 1;
});
