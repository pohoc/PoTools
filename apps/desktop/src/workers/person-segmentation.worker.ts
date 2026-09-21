import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision';

type RequestMessage = { id: number; bytes: ArrayBuffer };
type WorkerScope = {
  onmessage: ((event: MessageEvent<RequestMessage>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

const scope = self as unknown as WorkerScope;
let task: Promise<ImageSegmenter> | null = null;

async function getTask(): Promise<ImageSegmenter> {
  task ??= (async () => {
    const basePath = new URL(`${import.meta.env.BASE_URL}mediapipe/`, self.location.origin).href;
    const modelPath = new URL(`${import.meta.env.BASE_URL}models/selfie_segmenter.tflite`, self.location.origin).href;
    const fileset = await FilesetResolver.forVisionTasks(basePath, true);
    return ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: modelPath, delegate: 'CPU' },
      runningMode: 'IMAGE',
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    });
  })();
  return task;
}

scope.onmessage = async ({ data }) => {
  let bitmap: ImageBitmap | null = null;
  let result: ReturnType<Awaited<ReturnType<typeof getTask>>['segment']> | null = null;
  try {
    const segmenter = await getTask();
    bitmap = await createImageBitmap(new Blob([data.bytes]));
    result = segmenter.segment(bitmap);
    const labels = segmenter.getLabels();
    const personIndex = Math.max(0, labels.findIndex((label) => label.toLowerCase() === 'person'));
    const mask = result.confidenceMasks?.[personIndex] ?? result.confidenceMasks?.[0];
    if (!mask) throw new Error('人物分割没有返回前景遮罩');

    const values = mask.getAsFloat32Array();
    const maskCanvas = new OffscreenCanvas(mask.width, mask.height);
    const maskContext = maskCanvas.getContext('2d');
    if (!maskContext) throw new Error('无法创建图像遮罩');
    const rgba = new Uint8ClampedArray(values.length * 4);
    for (let i = 0; i < values.length; i += 1) {
      const alpha = Math.round(Math.max(0, Math.min(1, values[i] ?? 0)) * 255);
      const offset = i * 4;
      rgba[offset] = rgba[offset + 1] = rgba[offset + 2] = 255;
      rgba[offset + 3] = alpha;
    }
    maskContext.putImageData(new ImageData(rgba, mask.width, mask.height), 0, 0);

    const outputCanvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const outputContext = outputCanvas.getContext('2d', { willReadFrequently: true });
    if (!outputContext) throw new Error('无法创建输出画布');
    outputContext.drawImage(bitmap, 0, 0);
    const original = outputContext.getImageData(0, 0, bitmap.width, bitmap.height);
    const enlargedMask = new OffscreenCanvas(bitmap.width, bitmap.height);
    const enlargedContext = enlargedMask.getContext('2d', { willReadFrequently: true });
    if (!enlargedContext) throw new Error('无法生成高清遮罩');
    enlargedContext.imageSmoothingEnabled = true;
    enlargedContext.drawImage(maskCanvas, 0, 0, bitmap.width, bitmap.height);
    const alpha = enlargedContext.getImageData(0, 0, bitmap.width, bitmap.height).data;
    for (let i = 0; i < original.data.length; i += 4) {
      original.data[i + 3] = Math.round((original.data[i + 3] ?? 0) * (alpha[i + 3] ?? 0) / 255);
    }
    outputContext.putImageData(original, 0, 0);
    const blob = await outputCanvas.convertToBlob({ type: 'image/png' });
    const bytes = await blob.arrayBuffer();
    scope.postMessage({ id: data.id, bytes, width: bitmap.width, height: bitmap.height }, [bytes]);
  } catch (error) {
    scope.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) });
  } finally {
    result?.confidenceMasks?.forEach((mask) => mask.close());
    bitmap?.close();
  }
};
