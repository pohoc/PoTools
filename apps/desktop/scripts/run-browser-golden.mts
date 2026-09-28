/**
 * Browser golden runner (worker-only migration phase 0): replays the
 * Node-captured golden file against the real embedded-engine Worker inside
 * Chromium (Playwright) and classifies every entry:
 *   PASS      — byte/contract parity with the Node oracle
 *   FALLBACK  — Worker returned handled:false where Node succeeded (phase 3/4 work)
 *   DIFF      — handled but output diverges (real regression to fix)
 *   CRASH     — worker/page error
 */
import { readFile } from 'node:fs/promises';
import { createServer, type ViteDevServer } from 'vite';
import { chromium } from 'playwright';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(DESKTOP_ROOT, '../..');
const GOLDEN_PATH = resolve(REPO_ROOT, 'packages/engine/testdata/golden-node.json');

interface GoldenEntry {
  kind: 'text' | 'job';
  tool: string;
  inputs: { files?: string[]; options?: Record<string, unknown>; locale?: string };
  state?: string;
  error?: { code: string; message: string } | null;
  warnings: string[];
  text?: string;
  summary?: Record<string, unknown>;
  artifacts?: Array<{ name: string; kind: string; sha256?: string }>;
  stable?: boolean;
  inputRandom?: boolean;
}

interface CasePayload {
  key: string;
  kind: 'text' | 'job';
  tool: string;
  options: Record<string, unknown>;
  locale?: string;
  files?: Array<{ name: string; url: string }>;
}

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/** "(2)"-style suffixes depend on the capture environment's output dir, not the contract. */
function normalizeArtifactName(name: string): string {
  return name.replace(/ \(\d+\)(?=\.[^./]*$)/, '');
}

/** x509 output embeds remaining-time figures that legitimately tick with real time. */
function normalizeDynamicText(tool: string, text: string): string {
  if (tool === 'x509') return text.replace(/\d+(?:\.\d+)? 天/g, 'N 天');
  return text;
}

/**
 * Tools whose artifacts come from engines with no byte-level cross-implementation
 * parity: native MuPDF vs MuPDF WASM, native ONNX vs ONNX Runtime Web, and
 * sharp/libvips encoding vs OffscreenCanvas/jpeg-js/UTIF. The migration
 * history compares these by pixels/structure, so the golden compares state,
 * names, warnings, and summary — not digests. pdf-lib-only tools stay
 * byte-strict on purpose; their diffs are real signals.
 */
const STRUCTURAL_ONLY_TOOLS = new Set([
  'compress', 'repair', 'ocr-text', 'ocr-table',
  'image-compress', 'image-resize', 'image-crop', 'image-rotate', 'image-convert',
  'image-info', 'image-cutout', 'image-metadata-clean', 'image-print',
  'image-watermark-clean', 'image-id-photo',
  'images-to-pdf', 'invoice-merge', 'pdf-to-images', 'pdf-to-ppt', 'pdf-to-excel',
  'extract-images',
]);

async function main(): Promise<void> {
  const keysFilter = process.argv.find((arg) => arg.startsWith('--keys='))?.slice(7)
    .split(',').map((item) => item.trim()).filter(Boolean) ?? [];
  const golden = JSON.parse(await readFile(GOLDEN_PATH, 'utf8')) as { entries: Record<string, GoldenEntry> };
  const selected = keysFilter.length
    ? Object.fromEntries(Object.entries(golden.entries).filter(([key]) => keysFilter.some((fragment) => key.includes(fragment))))
    : golden.entries;
  const samplesDir = resolve(REPO_ROOT, 'samples');
  const cases: CasePayload[] = Object.entries(selected).map(([key, entry]) => ({
    key,
    kind: entry.kind,
    tool: entry.tool,
    options: entry.inputs.options ?? {},
    locale: entry.inputs.locale,
    files: (entry.inputs.files ?? []).map((name) => ({ name, url: `/@fs${join(samplesDir, name)}` })),
  }));

  const server: ViteDevServer = await createServer({
    configFile: resolve(REPO_ROOT, 'apps/desktop/vite.config.ts'),
    root: resolve(REPO_ROOT, 'apps/desktop'),
    logLevel: 'error',
    server: { port: 0, strictPort: false },
  });
  await server.listen();
  const resolvedPort = (server.httpServer?.address() as { port: number }).port;

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const outcomes: Array<Record<string, unknown>> = [];
  let page = await context.newPage();
  page.on('pageerror', (error) => console.error('[pageerror]', error.message));
  await page.exposeFunction('__goldenProgress', (key: string, index: number, total: number) => {
    if (index % 25 === 0) console.error(`[progress] ${index}/${total} ${key}`);
  });
  const openHarness = async () => {
    await page.goto(`http://127.0.0.1:${resolvedPort}/harness/index.html`);
    await page.waitForFunction(() => Boolean((globalThis as unknown as { __golden?: unknown }).__golden));
  };
  await openHarness();

  // Small chunks keep renderer memory flat; a destroyed context (renderer
  // crash, vite reload) costs one retry, not the whole run.
  const CHUNK = 25;
  for (let start = 0; start < cases.length; start += CHUNK) {
    const chunk = cases.slice(start, start + CHUNK);
    try {
      const part = (await page.evaluate(
        async (payload: CasePayload[]) => await (globalThis as unknown as { __golden: { run(c: CasePayload[]): Promise<unknown[]> } }).__golden.run(payload),
        chunk,
      )) as Array<Record<string, unknown>>;
      outcomes.push(...part);
    } catch (error) {
      console.error(`[chunk ${start}-${start + chunk.length} failed: ${String(error).split('\n')[0]} — reloading once]`);
      await page.close();
      page = await context.newPage();
      page.on('pageerror', (err) => console.error('[pageerror]', err.message));
      await page.exposeFunction('__goldenProgress', (key: string, index: number, total: number) => {
        if (index % 25 === 0) console.error(`[progress] ${index}/${total} ${key}`);
      });
      try {
        await openHarness();
        const part = (await page.evaluate(
          async (payload: CasePayload[]) => await (globalThis as unknown as { __golden: { run(c: CasePayload[]): Promise<unknown[]> } }).__golden.run(payload),
          chunk,
        )) as Array<Record<string, unknown>>;
        outcomes.push(...part);
      } catch (retryError) {
        for (const item of chunk) {
          outcomes.push({ key: item.key, handled: false, crash: String(retryError).split('\n')[0] });
        }
      }
    }
  }
  console.error('[progress] replay finished');
  await browser.close();
  await server.close();

  const byKey = new Map(outcomes.map((item) => [String(item.key), item]));
  let pass = 0;
  let fallback = 0;
  let diff = 0;
  let crash = 0;
  const details: string[] = [];

  for (const [key, entry] of Object.entries(selected)) {
    const outcome = byKey.get(key);
    if (!outcome) {
      diff += 1;
      details.push(`DIFF  ${key}: 无回放结果`);
      continue;
    }
    if (outcome.crash) {
      crash += 1;
      details.push(`CRASH ${key}: ${outcome.crash}`);
      continue;
    }
    if (!outcome.handled) {
      if (entry.state === 'succeeded' || (entry.kind === 'text' && !entry.error)) {
        fallback += 1;
        details.push(`FALLBACK ${key} (${entry.tool})`);
      } else {
        // Node also rejected this input; a clean unhandled reply matches the contract.
        pass += 1;
      }
      continue;
    }
    if (entry.kind === 'text') {
      const result = outcome.result as { text?: string; warnings?: string[] } | null;
      const expectError = entry.error ?? null;
      const actualError = (outcome.error as { code?: string } | null) ?? null;
      if (expectError) {
        if (actualError?.code === expectError.code) pass += 1;
        else {
          diff += 1;
          details.push(`DIFF  ${key}: 错误码 ${actualError?.code} ≠ ${expectError.code}`);
        }
        continue;
      }
      if (entry.text !== undefined && entry.stable) {
        if (normalizeDynamicText(entry.tool, result?.text ?? '') === normalizeDynamicText(entry.tool, entry.text ?? '')
          && equalJson(result?.warnings ?? [], entry.warnings)) pass += 1;
        else {
          diff += 1;
          const expected = entry.text ?? '';
          const actual = result?.text ?? '';
          let at = 0;
          while (at < Math.min(expected.length, actual.length) && expected[at] === actual[at]) at += 1;
          const dumpFragment = process.env.POTOOLS_GOLDEN_DUMP;
          if (dumpFragment && key.includes(dumpFragment)) {
            await import('node:fs/promises').then((fs) => Promise.all([
              fs.writeFile(`/tmp/golden-expected.txt`, expected),
              fs.writeFile(`/tmp/golden-actual.txt`, actual),
            ]));
          }
          details.push(`DIFF  ${key}: text 与 Node 不一致 @${at}\n        期望 ${JSON.stringify(expected.slice(at, at + 90))}\n        实际 ${JSON.stringify(actual.slice(at, at + 90))}`);
        }
      } else if (equalJson(result?.warnings ?? [], entry.warnings)) {
        // inputRandom (replayed random inputs) and digest-stripped entries:
        // only the stable surface (warnings/error contract) is comparable.
        pass += 1;
      } else {
        diff += 1;
        details.push(`DIFF  ${key}: warnings 不一致`);
      }
      continue;
    }
    // job entry
    const jobResult = outcome.jobResult as { snapshot?: { progress?: { state?: string }; error?: { code?: string }; warnings?: string[] }; artifacts?: Array<{ name: string; sha256: string }> } | null;
    const snapshot = jobResult?.snapshot as { progress?: { state?: string }; error?: { code?: string }; warnings?: string[]; summary?: Record<string, unknown> } | undefined;
    if (entry.state === 'failed') {
      if (snapshot?.error?.code === entry.error?.code) pass += 1;
      else {
        diff += 1;
        details.push(`DIFF  ${key}: 错误码 ${snapshot?.error?.code} ≠ ${entry.error?.code}`);
      }
      continue;
    }
    const artifacts = jobResult?.artifacts ?? [];
    if (snapshot?.progress?.state !== 'succeeded') {
      diff += 1;
      details.push(`DIFF  ${key}: 状态 ${snapshot?.progress?.state} ≠ succeeded (${snapshot?.error?.code})`);
      continue;
    }
    const namesOk = (entry.artifacts ?? []).length === artifacts.length
      && (entry.artifacts ?? []).every((artifact, index) => normalizeArtifactName(artifact.name) === normalizeArtifactName(artifacts[index]?.name ?? ''));
    if (!namesOk) {
      diff += 1;
      details.push(`DIFF  ${key}: 产物名称/数量不一致 (${(entry.artifacts ?? []).map((a) => a.name).join(',')} vs ${artifacts.map((a) => a.name).join(',')})`);
      continue;
    }
    const digestExpected = entry.artifacts?.[0]?.sha256 !== undefined && !STRUCTURAL_ONLY_TOOLS.has(entry.tool);
    if (digestExpected) {
      const digestsOk = artifacts.every((artifact, index) => artifact.sha256 === entry.artifacts?.[index]?.sha256);
      if (!digestsOk) {
        diff += 1;
        details.push(`DIFF  ${key}: 产物 canonical digest 不一致`);
        continue;
      }
    }
    if (!equalJson(snapshot.warnings ?? [], entry.warnings)) {
      diff += 1;
      details.push(`DIFF  ${key}: warnings 不一致`);
      continue;
    }
    if (entry.summary) {
      // outputBytes/sizeDeltaPercent tick with embedded timestamps on both
      // sides; structural producers additionally differ in size-derived
      // summary.extra, which is not part of their contract.
      const normalize = (value: Record<string, unknown> | undefined) => {
        const base = { ...value, outputBytes: undefined, sizeDeltaPercent: undefined };
        if (STRUCTURAL_ONLY_TOOLS.has(entry.tool)) base.extra = undefined;
        return base;
      };
      if (!equalJson(normalize(snapshot.summary), normalize({ ...entry.summary }))) {
        diff += 1;
        details.push(`DIFF  ${key}: summary 不一致`);
        continue;
      }
    }
    pass += 1;
  }

  console.log(`\nbrowser golden: ${pass} PASS, ${fallback} FALLBACK, ${diff} DIFF, ${crash} CRASH / ${Object.keys(golden.entries).length} entries`);
  if (details.length) console.log(`${details.join('\n')}\n`);
  if (diff > 0 || crash > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
