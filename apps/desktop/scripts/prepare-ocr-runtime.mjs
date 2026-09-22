import { access, cp, mkdir, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const engineDist = join(root, 'packages/engine/dist');
const source = join(root, 'packages/engine/ocr-models');
const target = join(engineDist, 'ocr-models');
const archive = process.env.POTOOLS_PADDLEOCR_MODELS_ARCHIVE;

await rm(target, { recursive: true, force: true });
if (!archive) {
  await access(join(source, 'PP-OCRv6_small_det_infer.onnx'), constants.R_OK);
  await cp(source, target, { recursive: true });
  console.log(`[ocr] bundled repository PP-OCRv6_small models at ${target}`);
  process.exit(0);
}

await access(archive, constants.R_OK);
await mkdir(target, { recursive: true });
if (archive.endsWith('.zip')) {
  await execFileAsync('unzip', ['-q', archive, '-d', target]);
} else {
  await execFileAsync('tar', ['-xf', archive, '-C', target]);
}
for (const file of ['PP-OCRv6_small_det_infer.onnx', 'PP-OCRv6_small_rec_infer.onnx', 'ppocrv6_dict.txt']) {
  await access(join(target, file), constants.R_OK);
}
console.log(`[ocr] bundled PP-OCRv6_small models at ${target}`);
