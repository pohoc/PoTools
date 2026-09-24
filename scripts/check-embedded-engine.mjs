import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = path.join(root, 'packages/engine/dist/engine-embedded.cjs');
const sample = await readFile(path.join(root, 'samples/sample-scan-2.png'));
const scratch = await mkdtemp(path.join(tmpdir(), 'potools-embedded-check-'));
const executable = process.env.POTOOLS_EMBEDDED_EXE
  ? path.resolve(process.env.POTOOLS_EMBEDDED_EXE)
  : process.execPath;
const engineArgs = process.env.POTOOLS_EMBEDDED_EXE
  ? ['--engine-child', 'serve', '--stdio', '--concurrency', '1']
  : [bundle, 'serve', '--stdio', '--concurrency', '1'];
const localAppData = path.join(scratch, 'LocalAppData');
const appData = path.join(scratch, 'AppData');
await Promise.all([mkdir(localAppData), mkdir(appData)]);
const requests = [
  { id: 'image-info-check', tool: 'image-info', options: {} },
  { id: 'image-compress-check', tool: 'image-compress', options: {
    quality: 80, maxEdge: 1024, format: 'jpeg', background: '#ffffff',
  } },
  { id: 'ocr-text-check', tool: 'ocr-text', options: {} },
];
const pending = new Map(requests.map((request) => [request.id, request.tool]));
const completed = new Map();
const child = spawn(executable, engineArgs, {
  cwd: scratch,
  env: {
    ...process.env,
    POTOOLS_TEMP: path.join(scratch, 'jobs'),
    LOCALAPPDATA: localAppData,
    APPDATA: appData,
    TEMP: scratch,
    TMP: scratch,
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });

try {
  await new Promise((resolve, reject) => {
    let stdout = '';
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      reject(error);
    };
    const timeout = setTimeout(() => fail(new Error('Embedded engine check timed out')), 90_000);
    const succeed = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    child.once('error', fail);
    child.once('exit', (code) => {
      if (pending.size) fail(new Error(`Embedded engine exited with code ${code}; pending: ${[...pending.keys()].join(', ')}`));
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      let newline;
      while ((newline = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        let frame;
        try { frame = JSON.parse(line); } catch { fail(new Error(`Invalid engine frame: ${line.slice(0, 200)}`)); return; }
        if (frame.id === 'ready') {
          if (!frame.result?.features?.imageCodec) {
            fail(new Error('Embedded image codec is unavailable'));
            return;
          }
          for (const request of requests) {
            child.stdin.write(`${JSON.stringify({
              jsonrpc: '2.0', id: request.id, method: 'job.submit',
              params: { job: {
                ...request,
                files: [{ id: 'scan', name: 'sample-scan-2.png', dataBase64: sample.toString('base64') }],
                globals: { locale: 'zh-CN' },
              } },
            })}\n`);
          }
        } else if (frame.event === 'job.updated' && pending.has(frame.job?.id)) {
          const job = frame.job;
          if (job.progress?.state === 'failed') {
            fail(new Error(`${job.tool}: ${job.error?.message ?? 'job failed'}`));
            return;
          }
          if (job.progress?.state === 'succeeded') {
            if (!job.artifacts?.length) {
              fail(new Error(`${job.tool} produced no artifact`));
              return;
            }
            completed.set(job.id, job);
            pending.delete(job.id);
            if (!pending.size) succeed();
          }
        }
      }
    });
  });
  const artifactBytes = async (id) => {
    const artifact = completed.get(id)?.artifacts?.[0];
    if (!artifact?.path) throw new Error(`${id} produced no readable artifact path`);
    return readFile(artifact.path);
  };
  const info = JSON.parse((await artifactBytes('image-info-check')).toString('utf8'));
  if (!JSON.stringify(info).includes('png')) throw new Error('Image info did not describe the PNG input');
  const jpeg = await artifactBytes('image-compress-check');
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('Image compression did not produce JPEG bytes');
  const ocrText = (await artifactBytes('ocr-text-check')).toString('utf8').trim();
  if (!ocrText) throw new Error('OCR produced an empty text artifact');
  const runtimeFiles = (await readdir(scratch, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.(?:node|dll|mjs|cjs|wasm|exe)$/i.test(entry.name))
    .map((entry) => entry.name);
  if (runtimeFiles.length) {
    throw new Error(`Embedded engine extracted runtime files: ${runtimeFiles.join(', ')}`);
  }
  console.log(`[embedded-engine] image info, JPEG compression and OCR completed from an isolated directory using ${process.env.POTOOLS_EMBEDDED_EXE ? 'PoTools.exe' : 'Node'}`);
} catch (error) {
  console.error(stderr);
  throw error;
} finally {
  child.kill();
  await rm(scratch, { recursive: true, force: true });
}
