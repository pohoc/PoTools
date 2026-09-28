/**
 * Node-side counterpart of the browser golden byte dump: runs one tool case
 * through the real engine and writes artifacts to /tmp/golden-dump-node/.
 * Usage: tsx scripts/dump-node-artifact.mts <tool> <file1,file2> '<options-json>'
 */
import { createEngine } from '../src/rpc.ts';
import type { ToolId } from '@potools/core';
import { readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const [tool, filesArg, optionsArg] = process.argv.slice(2);
if (!tool || !filesArg) {
  console.error('usage: tsx scripts/dump-node-artifact.mts <tool> <file1,file2> [options-json]');
  process.exit(1);
}
const SAMPLES = resolve(process.cwd(), '../../samples');
const OUT = '/tmp/golden-dump-node';
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const { defaultOptions } = await import('@potools/core');
const engine = await createEngine({ concurrency: 1 });
const terminal = new Set(['succeeded', 'failed', 'cancelled']);
const id = `dump-${tool}`;
const settled = new Promise<any>((res) => {
  const un = engine.manager.on((event: any) => {
    if (event.event !== 'job.updated' || event.job.id !== id) return;
    if (!terminal.has(event.job.progress.state)) return;
    un();
    res(event.job);
  });
});
engine.manager.submit({
  id,
  tool: tool as ToolId,
  files: filesArg.split(',').map((name, index) => ({ id: `${name}-${index}`, name, path: resolve(SAMPLES, name) })),
  options: { ...defaultOptions(tool as ToolId), ...JSON.parse(optionsArg ?? '{}') },
  output: { dir: OUT },
});
const job = await settled;
if (job.progress.state !== 'succeeded') {
  console.error(`job ${job.progress.state}: ${job.error?.code}: ${job.error?.message}`);
  process.exit(1);
}
const { readdir } = await import('node:fs/promises');
for (const name of await readdir(OUT)) {
  console.log(join(OUT, name));
}
process.exit(0);
