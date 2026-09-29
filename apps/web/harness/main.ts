/**
 * Golden replay harness page (worker-only migration phase 0): hosts the real
 * embedded-engine Worker and replays captured tool.run / job.submit cases.
 * `run-browser-golden.mts` drives it through Playwright and diffs replies
 * against the Node-captured golden file.
 */
import { defaultOptions } from '../src/lib/core-bindings.ts';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import { canonicalArtifactDigest } from './canonical-artifact.ts';
import { ensureRustCore } from '../src/lib/rust-core.ts';

await ensureRustCore();

interface ReplyMessage {
  id: number;
  handled?: boolean;
  progress?: unknown;
  [field: string]: unknown;
}

const worker = new Worker(new URL('../src/lib/embedded-engine.worker.ts', import.meta.url), { type: 'module' });
void pdfWorkerUrl;

let sequence = 0;
const pending = new Map<number, { resolve: (reply: ReplyMessage) => void; reject: (error: Error) => void }>();

worker.onmessage = ({ data }: MessageEvent<ReplyMessage>) => {
  // Progress events share the request id; only final replies carry `handled`.
  if (data.progress !== undefined && data.handled === undefined) return;
  const entry = pending.get(data.id);
  if (!entry) return;
  pending.delete(data.id);
  entry.resolve(data);
};

worker.onerror = (event) => {
  const error = new Error(`worker crashed: ${event.message}`);
  for (const entry of pending.values()) entry.reject(error);
  pending.clear();
};

function callWorker(message: Record<string, unknown>, transfer: Transferable[]): Promise<ReplyMessage> {
  const id = (sequence += 1);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, ...message }, transfer);
  });
}

interface GoldenCase {
  key: string;
  kind: 'text' | 'job';
  tool: string;
  options: Record<string, unknown>;
  locale?: string;
  files?: Array<{ name: string; url: string }>;
  /** Return artifact bytes base64 instead of digests (byte-level debugging). */
  dump?: boolean;
  /** Font file URLs to inject as `systemFonts` runtimeData, mirroring the app transport. */
  fontUrls?: string[];
}

const fontCache = new Map<string, Uint8Array>();

/** Mirrors transport.markupNeedsUnicodeFont against the merged options the worker will see. */
function markupNeedsUnicodeFont(tool: string, options: Record<string, unknown>, fileNames: string[]): boolean {
  const merged = { ...defaultOptions(tool as never), ...options };
  const text = [merged.text, merged.format, merged.header, merged.footer, ...fileNames]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
  return /[^\x00-\x7f]/u.test(text);
}

async function systemFontRuntimeData(item: GoldenCase): Promise<Record<string, unknown>> {
  if (item.tool === 'markdown-to-pdf' || item.tool === 'ofd-to-pdf' || item.tool === 'pdf-to-ofd') {
    // markdownRuntimeData/ofdRuntimeData: assets plus system fonts when no explicit font.
    return { markdownAssets: {}, ...(item.fontUrls?.length ? { systemFonts: await loadFonts(item.fontUrls) } : {}) };
  }
  if (item.fontUrls?.length && markupNeedsUnicodeFont(item.tool, item.options, (item.files ?? []).map((file) => file.name))) {
    return { systemFonts: await loadFonts(item.fontUrls) };
  }
  return {};
}

async function loadFonts(urls: string[]): Promise<Array<{ name: string; bytes: Uint8Array }>> {
  const fonts = await Promise.all(urls.map(async (url) => {
    let bytes = fontCache.get(url);
    if (!bytes) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`font fetch failed: HTTP ${response.status}`);
      bytes = new Uint8Array(await response.arrayBuffer());
      fontCache.set(url, bytes);
    }
    const path = new URL(url, location.origin).searchParams.get('path') ?? '';
    return { name: path.split('/').pop() ?? path, bytes };
  }));
  return fonts;
}

/**
 * The Node harness captures options that reference files by `fileId` values
 * like "sample-a.pdf-13" (its global counter suffix). Rewrites those to the
 * replay inputs' actual ids, tolerating the missing/present suffix.
 */
function remapFileIds(value: unknown, idByName: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map((entry) => remapFileIds(entry, idByName));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'fileId' && typeof entry === 'string') {
        out[key] = idByName.get(entry) ?? idByName.get(entry.replace(/-\d+$/, '')) ?? entry;
      } else {
        out[key] = remapFileIds(entry, idByName);
      }
    }
    return out;
  }
  return value;
}

interface GoldenOutcome {
  key: string;
  handled: boolean;
  result?: unknown;
  jobResult?: { snapshot?: unknown; artifacts?: Array<{ name: string; kind: string; sha256: string }> } | null;
  error?: { code?: string; message?: string } | null;
  crash?: string;
}

(globalThis as unknown as { __golden: { run(cases: GoldenCase[]): Promise<GoldenOutcome[]> } }).__golden = {
  async run(cases: GoldenCase[]): Promise<GoldenOutcome[]> {
    const notify = (globalThis as unknown as { __goldenProgress?: (key: string, index: number, total: number) => void }).__goldenProgress;
    const outcomes: GoldenOutcome[] = [];
    for (let index = 0; index < cases.length; index += 1) {
      const item = cases[index];
      try {
        // The watermark-clean inpaint loop is heavy on large photos; allow it
        // a longer budget than the generic 60s case guard.
        const budget = item.tool === 'image-watermark-clean' ? 300_000 : 60_000;
        const guard = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`case timeout (${budget / 1000}s)`)), budget));
        let outcome: GoldenOutcome;
        if (item.kind === 'text') {
          outcome = await Promise.race([
            (async (): Promise<GoldenOutcome> => {
              const reply = await callWorker({
                rpc: { method: 'tool.run', params: { tool: item.tool, options: item.options, globals: { locale: item.locale ?? 'zh-CN' } } },
                inputs: [],
              }, []);
              return {
                key: item.key,
                handled: Boolean(reply.handled),
                result: reply.result ?? null,
                error: (reply.error as GoldenOutcome['error']) ?? null,
              };
            })(),
            guard,
          ]);
        } else {
          outcome = await Promise.race([
            (async (): Promise<GoldenOutcome> => {
              const inputs = [] as Array<{ id: string; name: string; path: string | null; bytes: Uint8Array }>;
              for (const file of item.files ?? []) {
                const response = await fetch(file.url);
                if (!response.ok) throw new Error(`sample fetch failed: ${file.url} HTTP ${response.status}`);
                inputs.push({ id: file.name, name: file.name, path: null, bytes: new Uint8Array(await response.arrayBuffer()) });
              }
              const runtimeData = await systemFontRuntimeData(item);
              const idByName = new Map(inputs.map((input) => [input.name, input.id]));
              const job = {
                id: item.key.replace(/[^A-Za-z0-9_-]/g, '-'),
                tool: item.tool,
                files: inputs.map((input) => ({ id: input.id, name: input.name })),
                options: remapFileIds({ ...defaultOptions(item.tool as never), ...item.options }, idByName),
                output: { dir: '' },
              };
              const reply = await callWorker({
                rpc: { method: 'job.submit', params: { job } },
                inputs,
                runtimeData,
              }, inputs.map((input) => input.bytes.buffer));
              const jobResult = (reply.jobResult as GoldenOutcome['jobResult']) ?? null;
              // Digest inside the page so multi-MB artifacts never pile up
              // in the renderer nor cross the Playwright serialization bridge.
              let digested = jobResult;
              if (jobResult?.artifacts) {
                digested = {
                  ...jobResult,
                  artifacts: await Promise.all(jobResult.artifacts.map(async (artifact) => ({
                    name: artifact.name,
                    kind: artifact.kind,
                    ...(item.dump
                      ? { dataBase64: btoa(String.fromCharCode(...artifact.bytes.subarray(0, Math.min(artifact.bytes.length, 24_000_000)))) }
                      : { sha256: await canonicalArtifactDigest(artifact.bytes, artifact.kind) }),
                  }))),
                };
              }
              return {
                key: item.key,
                handled: Boolean(reply.handled),
                jobResult: digested,
                error: (reply.error as GoldenOutcome['error']) ?? null,
              };
            })(),
            guard,
          ]);
        }
        outcomes.push(outcome);
      } catch (error) {
        outcomes.push({ key: item.key, handled: false, crash: error instanceof Error ? error.message : String(error) });
      }
      notify?.(item.key, index + 1, cases.length);
    }
    return outcomes;
  },
};
