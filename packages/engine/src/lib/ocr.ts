import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { EngineError } from '../errors.ts';
import { getSharp } from './images.ts';

export interface OcrLine { text: string; confidence?: number; box?: [number, number, number, number] }
export interface OcrPageResult { text: string; lines: OcrLine[]; model: string }
type LocalOcr = { recognize(input: { width: number; height: number; data: Uint8Array }): Promise<unknown[]>; processRecognition(results: unknown[]): { text?: string; items?: Array<{ text?: string; score?: number; box?: number[][] }> } };
let servicePromise: Promise<LocalOcr> | null = null;

/** Local PaddleOCR/ONNX Runtime provider. No Python, subprocess, or network calls. */
export async function recognizePaddlePage(png: Uint8Array): Promise<OcrPageResult> {
  const sharp = await getSharp();
  if (!sharp) throw new EngineError('no_image_codec', 'sharp is unavailable', 'error.noImageCodec');
  const modelDir = await findModelDir();
  if (!modelDir) throw new EngineError('unsupported', 'OCR model files were not found.', 'error.ocrModelMissing');
  const pixels = await sharp(Buffer.from(png), { failOn: 'none' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const service = await getService(modelDir);
  const results = await service.recognize({ width: pixels.info.width, height: pixels.info.height, data: new Uint8Array(pixels.data) });
  const processed = service.processRecognition(results);
  const lines = (processed.items ?? []).map((item) => ({
    text: String(item.text ?? '').trim(),
    confidence: typeof item.score === 'number' ? item.score : undefined,
    box: item.box?.length ? [
      Math.min(...item.box.map((point) => point[0] ?? 0)),
      Math.min(...item.box.map((point) => point[1] ?? 0)),
      Math.max(...item.box.map((point) => point[0] ?? 0)),
      Math.max(...item.box.map((point) => point[1] ?? 0)),
    ] as [number, number, number, number] : undefined,
  })).filter((line) => line.text);
  return { text: String(processed.text ?? lines.map((line) => line.text).join('\n')), lines, model: 'PP-OCRv6_small' };
}

async function getService(modelDir: string): Promise<LocalOcr> {
  if (!servicePromise) {
    servicePromise = (async () => {
      const [{ PaddleOcrService }, ort] = await Promise.all([import('paddleocr'), import('onnxruntime-node')]);
      const readBuffer = async (name: string): Promise<ArrayBuffer> => {
        const bytes = await readFile(join(modelDir, name));
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      };
      const dictionary = (await readFile(join(modelDir, 'ppocrv6_dict.txt'), 'utf8')).trimEnd().split(/\r?\n/);
      // PP-OCRv6 uses one extra space class in addition to the distributed
      // dictionary entries; the CTC blank is handled by the runtime.
      if (!dictionary.includes(' ')) dictionary.push(' ');
      return PaddleOcrService.createInstance({
        ort: ort as never,
        modelPreset: 'PP-OCRv6_small',
        detection: { modelBuffer: await readBuffer('PP-OCRv6_small_det_infer.onnx') },
        recognition: { modelBuffer: await readBuffer('PP-OCRv6_small_rec_infer.onnx'), charactersDictionary: dictionary },
      }) as Promise<LocalOcr>;
    })().catch((error) => {
      servicePromise = null;
      throw new EngineError('unsupported', `PaddleOCR initialization failed: ${error instanceof Error ? error.message : String(error)}`, 'error.ocrInit');
    });
  }
  return servicePromise;
}

async function findModelDir(): Promise<string | null> {
  const candidates = [process.env.POTOOLS_PADDLEOCR_MODEL_DIR, process.env.POTOOLS_RESOURCE_DIR ? join(process.env.POTOOLS_RESOURCE_DIR, 'ocr-models') : undefined, join(resolve(process.cwd(), 'dist'), 'ocr-models'), join(resolve(process.cwd(), 'ocr-models'))].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      await access(join(candidate, 'PP-OCRv6_small_det_infer.onnx'), constants.R_OK);
      await access(join(candidate, 'PP-OCRv6_small_rec_infer.onnx'), constants.R_OK);
      await access(join(candidate, 'ppocrv6_dict.txt'), constants.R_OK);
      return candidate;
    } catch { /* try next location */ }
  }
  return null;
}
