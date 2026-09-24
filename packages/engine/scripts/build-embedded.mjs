import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(packageRoot, 'dist');
const scratch = await mkdtemp(path.join(tmpdir(), 'potools-engine-embedded-'));
const mupdfBundle = path.join(scratch, 'mupdf-embedded.mjs');
const engineBundle = path.join(dist, 'engine-embedded.cjs');
const sharpWasmPackage = path.join(packageRoot, 'node_modules/@img/sharp-wasm32');
const ocrFiles = {
  detectionModel: path.join(packageRoot, 'ocr-models/PP-OCRv6_small_det_infer.onnx'),
  recognitionModel: path.join(packageRoot, 'ocr-models/PP-OCRv6_small_rec_infer.onnx'),
  dictionary: path.join(packageRoot, 'ocr-models/ppocrv6_dict.txt'),
  wasm: path.join(packageRoot, 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm'),
};

try {
  await mkdir(dist, { recursive: true });
  await build({
    absWorkingDir: packageRoot,
    entryPoints: ['scripts/embedded-mupdf-entry.mjs'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    loader: { '.wasm': 'base64' },
    define: { 'import.meta.url': '"file:///potools/embedded/mupdf.mjs"' },
    outfile: mupdfBundle,
    logLevel: 'info',
  });

  await build({
    absWorkingDir: packageRoot,
    entryPoints: ['src/index.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    define: { 'import.meta.url': '"file:///potools/embedded/engine-embedded.cjs"' },
    external: ['mupdf', 'onnxruntime-node'],
    plugins: [createSharpWasmPlugin(), createOrtWasmPlugin()],
    outfile: engineBundle,
    logLevel: 'info',
  });

  const mupdfData = (await readFile(mupdfBundle)).toString('base64');
  const ocrData = Object.fromEntries(await Promise.all(
    Object.entries(ocrFiles).map(async ([name, file]) => [name, (await readFile(file)).toString('base64')]),
  ));
  const existingEngine = await readFile(engineBundle, 'utf8');
  const bootstrap = [
    `globalThis.__POTOOLS_MUPDF_MODULE_URL__ ||= "data:text/javascript;base64,${mupdfData}";`,
    `globalThis.__POTOOLS_EMBEDDED_OCR_ASSETS__ ||= Object.fromEntries(Object.entries(${JSON.stringify(ocrData)}).map(([key, value]) => [key, Buffer.from(value, "base64")]));`,
    '',
  ].join('\n');
  if (existingEngine.startsWith('#!')) {
    const newline = existingEngine.indexOf('\n');
    await writeFile(engineBundle, `${existingEngine.slice(0, newline + 1)}${bootstrap}${existingEngine.slice(newline + 1)}`, 'utf8');
  } else {
    await writeFile(engineBundle, bootstrap + existingEngine, 'utf8');
  }
} catch (error) {
  await rm(engineBundle, { force: true });
  throw error;
} finally {
  await rm(scratch, { recursive: true, force: true });
}

console.log(`[engine] embedded bundle written to ${engineBundle}`);

function createSharpWasmPlugin() {
  return {
    name: 'potools-inline-sharp-wasm',
    setup(buildApi) {
      buildApi.onLoad({ filter: /[\\/]sharp[\\/]dist[\\/].+\.(?:cjs|mjs)$/ }, async (args) => {
        const original = await readFile(args.path, 'utf8');
        let patched = original.replaceAll('createRequire(import.meta.url)', 'createRequire(__filename)');
        if (!/[/\\]sharp[/\\]dist[/\\]sharp\.(?:cjs|mjs)$/.test(args.path)) {
          return { contents: patched, loader: 'js', resolveDir: path.dirname(args.path) };
        }
        const optionalWasmFallback = [
          'if (!sharp) {',
          '  try {',
          '    sharp = require("@img/sharp-wasm32/sharp.node");',
          '  } catch (err) {',
          '    errors.push(err);',
          '  }',
          '}',
        ].join('\n');
        const isEsm = args.path.endsWith('.mjs');
        const withRuntimeSharpBase = isEsm
          ? replaceExactlyOnce(
            patched,
            'import { createRequire } from "node:module"',
            'import { createRequire } from "node:module";\nimport sharpWasmEmbedded from "@img/sharp-wasm32/sharp.node"',
          )
          : replaceExactlyOnce(
            patched,
            'const { spawnSync } = require("node:child_process");',
            'const sharpWasmEmbedded = require("@img/sharp-wasm32/sharp.node");\nconst { spawnSync } = require("node:child_process");',
          );
        const requiredFallback = 'if (!sharp) { sharp = sharpWasmEmbedded; }';
        return {
          contents: replaceExactlyOnce(withRuntimeSharpBase, optionalWasmFallback, requiredFallback),
          loader: 'js',
          resolveDir: path.dirname(args.path),
        };
      });

      buildApi.onResolve({ filter: /^@img\/sharp-wasm32\/sharp\.node$/ }, () => ({
        path: 'sharp-wasm32-addon',
        namespace: 'potools-sharp-wasm',
      }));

      buildApi.onLoad({ filter: /.*/, namespace: 'potools-sharp-wasm' }, async () => {
        const wasmPackage = JSON.parse(await readFile(path.join(sharpWasmPackage, 'package.json'), 'utf8'));
        const gluePath = path.join(sharpWasmPackage, 'lib', `sharp-wasm32-${wasmPackage.version}.node.js`);
        const wasmPath = path.join(sharpWasmPackage, 'lib', `sharp-wasm32-${wasmPackage.version}.node.wasm`);
        const wasmBase64 = (await readFile(wasmPath)).toString('base64');
        const original = await readFile(gluePath, 'utf8');
        const source = replaceExactlyOnce(
          replaceExactlyOnce(
            replaceExactlyOnce(
              original,
              'var Module=typeof Module!="undefined"?Module:{};',
              `var Module={wasmBinary:Buffer.from(${JSON.stringify(wasmBase64)},"base64")};`,
            ),
            'globalThis.Worker=worker_threads.Worker;',
            'globalThis.Worker=globalThis.__POTOOLS_WORKER_CLASS__||worker_threads.Worker;',
          ),
          'worker_threads.workerData=="em-pthread"',
          '(worker_threads.workerData==="em-pthread"||worker_threads.workerData?.emPthread===true)',
        );
        const workerSource = [
          'const wt=require("node:worker_threads");',
          'const workerData=wt.workerData;',
          'const source=workerData.sharpSource;',
          'const Native=wt.Worker;',
          'globalThis.__POTOOLS_WORKER_CLASS__=class extends Native{constructor(filename,options={}){if(options.workerData==="em-pthread"){super(source,{...options,eval:true,workerData:{emPthread:true,sharpSource:source}});}else{super(filename,options);}}};',
          source,
        ].join('\n');
        const parentPrefix = [
          'const {Worker:NativeWorker}=require("node:worker_threads");',
          `const sharpSource=${JSON.stringify(source)};`,
          `const pthreadSource=${JSON.stringify(workerSource)};`,
          'class EmbeddedSharpWorker extends NativeWorker{constructor(filename,options={}){if(options.workerData==="em-pthread"){super(pthreadSource,{...options,eval:true,workerData:{emPthread:true,sharpSource:sharpSource}});}else{super(filename,options);}}}',
          'globalThis.__POTOOLS_WORKER_CLASS__=EmbeddedSharpWorker;',
        ].join('\n');
        return {
          contents: `${parentPrefix}\n${source}`,
          loader: 'js',
          resolveDir: packageRoot,
        };
      });
    },
  };
}

function createOrtWasmPlugin() {
  return {
    name: 'potools-inline-ort-wasm',
    setup(buildApi) {
      buildApi.onLoad({ filter: /[\\/]onnxruntime-web[\\/]dist[\\/]ort\.wasm\.bundle\.min\.mjs$/ }, async (args) => {
        const original = await readFile(args.path, 'utf8');
        // The upstream bundle already contains the factory. In Node it checks its
        // synthetic file URL before the supplied in-memory WASM binary and then
        // tries to import a sibling .mjs file that does not exist in the EXE.
        const patched = replaceExactlyOnce(
          original,
          'if(a)if(te)a=Yt(te);else if(n&&!s)a=!0;',
          'if(a)if(n&&!s)a=!0;else if(te)a=Yt(te);',
        );
        return { contents: patched, loader: 'js', resolveDir: path.dirname(args.path) };
      });
    },
  };
}

function replaceExactlyOnce(source, search, replacement) {
  const first = source.indexOf(search);
  if (first < 0 || source.indexOf(search, first + search.length) >= 0) {
    throw new Error(`Unexpected embedded dependency source; could not safely replace exactly one occurrence of: ${search}`);
  }
  return source.slice(0, first) + replacement + source.slice(first + search.length);
}
