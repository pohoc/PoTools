import { useEffect, useMemo, useRef, useState } from 'react';
import type { FieldValue, ToolId } from 'core';
import { useI18n } from '../i18n/index.tsx';
import { toFileRef, type PickedFile } from '../lib/files.ts';
import { useEngine } from '../stores/engine.ts';
import { Button as ShadcnButton } from './ui/button.tsx';
import { Button } from './ui.tsx';
import { Card } from './ui/card.tsx';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog.tsx';

type Preview = { url: string; width: number; height: number };

export function ImageStudioEditor({
  tool,
  source,
  options,
  onReady,
}: {
  tool: Extract<ToolId, 'image-cutout' | 'image-id-photo' | 'image-watermark-clean'>;
  source?: PickedFile;
  options: Record<string, FieldValue>;
  onReady: (file: File | null, overrides?: Record<string, FieldValue>) => void;
}) {
  const { t } = useI18n();
  const call = useEngine((state) => state.call);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [processed, setProcessed] = useState<File | null>(null);
  const [sourceUrl, setSourceUrl] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [large, setLarge] = useState(false);
  const [maskUrl, setMaskUrl] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [compare, setCompare] = useState(false);
  const [printUrl, setPrintUrl] = useState('');
  const [repairedPreviewUrl, setRepairedPreviewUrl] = useState('');
  const [sizeError, setSizeError] = useState('');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const busyLabel = busy ? t('imageStudio.preparing') : t('imageStudio.prepare');

  useEffect(() => {
    onReady(null);
    setProcessed(null);
    setPreview(null);
    setSourceUrl('');
    setError('');
    setMaskUrl(''); setHistory([]); setHistoryIndex(-1); setSizeError('');
    setRepairedPreviewUrl(''); setPrintUrl('');
    setBusy(false);
  }, [source?.id, onReady]);

  useEffect(() => () => {
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  }, [sourceUrl]);

  useEffect(() => () => {
    if (printUrl) URL.revokeObjectURL(printUrl);
    if (repairedPreviewUrl) URL.revokeObjectURL(repairedPreviewUrl);
  }, [printUrl, repairedPreviewUrl]);

  useEffect(() => {
    let disposed = false;
    let objectUrl = '';
    if (!processed) {
      setPreview(null);
      return;
    }
    void renderPreview(processed, tool, options).then((result) => {
      if (disposed) return;
      objectUrl = URL.createObjectURL(result.blob);
      setPreview({ url: objectUrl, width: result.width, height: result.height });
    }).catch((issue) => {
      if (!disposed) setError(issue instanceof Error ? issue.message : String(issue));
    });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [processed, tool, options]);

  useEffect(() => {
    if (tool !== 'image-id-photo' || !processed || options.printSheet !== true) { setPrintUrl(''); return; }
    let disposed = false;
    void renderPrintSheet(processed, options).then((blob) => {
      if (!disposed) setPrintUrl(URL.createObjectURL(blob));
    }).catch((issue) => { if (!disposed) setError(issue instanceof Error ? issue.message : String(issue)); });
    return () => { disposed = true; };
  }, [processed, tool, options]);

  const sourceLabel = useMemo(() => source?.name ?? t('imageStudio.needFile'), [source?.name, t]);

  const prepare = async () => {
    if (!source || busy) return;
    setBusy(true);
    setError('');
    setProcessed(null);
    onReady(null);
    try {
      let bytes: Uint8Array;
      if (source.file) {
        bytes = new Uint8Array(await source.file.arrayBuffer());
      } else {
        const ref = await toFileRef(source);
        const response = await call<{ dataBase64: string }>('file.bytes', { file: ref });
        bytes = decodeBase64(response.dataBase64);
      }
      const safeBytes = bytes.slice().buffer as ArrayBuffer;
      const originalBlob = new Blob([safeBytes], { type: mimeFor(source.name) });
      const nextSourceUrl = URL.createObjectURL(originalBlob);
      setSourceUrl((previous) => {
        if (previous) URL.revokeObjectURL(previous);
        return nextSourceUrl;
      });
      const result = tool === 'image-watermark-clean' ? new Blob([safeBytes], { type: mimeFor(source.name) }) : await isolatePerson(bytes);
      const stem = source.name.replace(/\.[^.]+$/, '') || 'portrait';
      const output = new File([result], `${stem}-${tool === 'image-watermark-clean' ? 'source' : 'cutout'}.png`, { type: 'image/png' });
      setProcessed(output);
      onReady(output);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : t('imageStudio.modelError'));
    } finally {
      setBusy(false);
    }
  };

  const snapshotMask = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const next = canvas.toDataURL('image/png');
    setHistory((items) => [...items.slice(0, historyIndex + 1), next]);
    setHistoryIndex((index) => index + 1);
    setMaskUrl(next);
  };

  useEffect(() => {
    if (tool !== 'image-watermark-clean' || !preview?.url) return;
    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (cancelled) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      if (context) {
        context.fillStyle = '#000'; context.fillRect(0, 0, canvas.width, canvas.height);
        if (historyIndex >= 0) {
          const mask = new Image();
          mask.onload = () => { context.drawImage(mask, 0, 0); };
          mask.src = history[historyIndex]!;
        }
      }
    };
    image.src = preview.url;
    return () => { cancelled = true; };
  }, [tool, preview?.url, history, historyIndex]);

  const runRepair = async () => {
    if (!source || !maskUrl || busy) return;
    setBusy(true); setError('');
    try {
      const mask = maskUrl.split(',')[1];
      if (processed && mask && preview?.url) {
        const image = await createImageBitmap(await (await fetch(preview.url)).blob());
        const canvas = new OffscreenCanvas(image.width, image.height);
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('无法生成修复预览');
        context.drawImage(image, 0, 0); image.close();
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
        const maskBitmap = await createImageBitmap(await (await fetch(maskUrl)).blob());
        const maskCanvas = new OffscreenCanvas(canvas.width, canvas.height);
        const maskContext = maskCanvas.getContext('2d', { willReadFrequently: true });
        if (!maskContext) throw new Error('无法读取修复选区');
        maskContext.drawImage(maskBitmap, 0, 0, canvas.width, canvas.height); maskBitmap.close();
        const maskPixels = maskContext.getImageData(0, 0, canvas.width, canvas.height).data;
        const sourcePixels = pixels.data;
        const radius = Math.max(1, Math.round(Math.min(canvas.width, canvas.height) / 180));
        for (let y = 0; y < canvas.height; y += 1) for (let x = 0; x < canvas.width; x += 1) {
          const at = (y * canvas.width + x) * 4;
          if ((maskPixels[at] ?? 0) < 32) continue;
          let r = 0; let g = 0; let b = 0; let n = 0;
          for (let dy = -radius; dy <= radius; dy += 1) for (let dx = -radius; dx <= radius; dx += 1) {
            const sx = x + dx; const sy = y + dy;
            if (sx < 0 || sy < 0 || sx >= canvas.width || sy >= canvas.height) continue;
            const sample = (sy * canvas.width + sx) * 4;
            if ((maskPixels[sample] ?? 0) >= 32) continue;
            r += sourcePixels[sample] ?? 0; g += sourcePixels[sample + 1] ?? 0; b += sourcePixels[sample + 2] ?? 0; n += 1;
          }
          if (n) { sourcePixels[at] = r / n; sourcePixels[at + 1] = g / n; sourcePixels[at + 2] = b / n; }
        }
        context.putImageData(pixels, 0, 0);
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        setRepairedPreviewUrl(URL.createObjectURL(blob));
        onReady(processed, { repairPng: mask });
      }
    } catch (issue) { setError(issue instanceof Error ? issue.message : String(issue)); }
    finally { setBusy(false); }
  };

  return (
    <section className="flex flex-col gap-3" aria-label={t('imageStudio.preview')}>
      <div className="flex flex-wrap items-center gap-2">
        {tool !== 'image-watermark-clean' ? <Button icon={busy ? 'spinner' : 'scan'} busy={busy} disabled={!source || busy} onClick={() => void prepare()}>{busyLabel}</Button> : <ShadcnButton disabled={!source || busy} onClick={() => void prepare()}>{t('imageStudio.loadImage')}</ShadcnButton>}
        <span className="min-w-0 truncate text-[11.5px] text-faint" title={sourceLabel}>{sourceLabel}</span>
      </div>
      <Card className="grid min-w-0 gap-3 p-3 sm:grid-cols-2">
        <PreviewTile title={t('imageStudio.inputLabel')} src={sourceUrl} empty={!sourceUrl} onOpen={() => { setCompare(false); setLarge(true); }} />
        <div className="min-w-0"><PreviewTile title={t('imageStudio.outputLabel')} src={compare ? sourceUrl : repairedPreviewUrl || preview?.url || sourceUrl} empty={!preview && !sourceUrl} onOpen={() => { setCompare(false); setLarge(true); }} checkerboard={tool === 'image-cutout' && options.transparent === true} />
          {tool === 'image-watermark-clean' && preview ? <div className="mt-2 flex flex-wrap gap-1.5"><Button size="sm" disabled={historyIndex < 0} onClick={() => { const i = Math.max(-1, historyIndex - 1); setHistoryIndex(i); setMaskUrl(i < 0 ? '' : history[i]!); }}>{t('imageStudio.undo')}</Button><Button size="sm" disabled={historyIndex >= history.length - 1} onClick={() => { const i = Math.min(history.length - 1, historyIndex + 1); setHistoryIndex(i); setMaskUrl(history[i] ?? ''); }}>{t('imageStudio.redo')}</Button><Button size="sm" onClick={() => setCompare(!compare)}>{compare ? t('imageStudio.showResult') : t('imageStudio.compare')}</Button><Button size="sm" disabled={!maskUrl || busy} onClick={() => void runRepair()}>{t('imageStudio.repair')}</Button></div> : null}
          {tool === 'image-id-photo' && printUrl ? <div className="mt-2"><p className="mb-1 text-[11px] text-faint">{t('imageStudio.printPreview')}</p><img src={printUrl} alt={t('imageStudio.printPreview')} className="max-h-[220px] w-full object-contain" /></div> : null}
          {sizeError ? <p role="alert" className="mt-2 text-[11px] text-bad">{sizeError}</p> : null}
        </div>
      </Card>
      {tool === 'image-watermark-clean' && preview ? <div className="relative mx-auto w-full max-w-[720px] overflow-hidden rounded-control border border-line" style={{ aspectRatio: `${preview.width}/${preview.height}` }}><img src={compare ? sourceUrl : preview.url} alt={compare ? t('imageStudio.inputLabel') : t('imageStudio.outputLabel')} className="absolute inset-0 h-full w-full object-contain" /><canvas ref={canvasRef} className="absolute inset-0 h-full w-full cursor-crosshair opacity-45 mix-blend-screen" onPointerDown={(e) => { drawingRef.current = true; e.currentTarget.setPointerCapture(e.pointerId); const c = e.currentTarget; const rect = c.getBoundingClientRect(); const x = (e.clientX - rect.left) / rect.width * c.width; const y = (e.clientY - rect.top) / rect.height * c.height; const ctx = c.getContext('2d'); if (ctx) { ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(10, c.width * .025); ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + .1, y + .1); ctx.stroke(); } }} onPointerMove={(e) => { if (!drawingRef.current) return; const c = e.currentTarget; const rect = c.getBoundingClientRect(); const ctx = c.getContext('2d'); if (!ctx) return; ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(10, c.width * .025); ctx.lineCap = 'round'; ctx.lineTo((e.clientX - rect.left) / rect.width * c.width, (e.clientY - rect.top) / rect.height * c.height); ctx.stroke(); }} onPointerUp={(e) => { drawingRef.current = false; snapshotMask(); }} /></div> : null}
      <div className="flex flex-col gap-1 text-[11px] leading-4 text-faint">
        <p>{t('imageStudio.localHint')}</p>
        <p>{t(tool === 'image-watermark-clean' ? 'imageStudio.watermarkLimit' : 'imageStudio.modelLimit')}</p>
      </div>
      {error ? <p role="alert" className="rounded-control bg-bad/10 px-3 py-2 text-[12px] leading-5 text-ink">{error}</p> : null}
      <Dialog open={large} onOpenChange={setLarge}>
        <DialogContent className="w-[min(94vw,72rem)] max-w-none p-0" aria-describedby="image-studio-preview-description">
          <DialogHeader className="border-b border-line px-5 py-4 pr-12">
            <DialogTitle className="text-[14px]">{t('imageStudio.preview')}</DialogTitle>
            <DialogDescription id="image-studio-preview-description" className="truncate">{preview ? `${preview.width} × ${preview.height} px` : sourceLabel}</DialogDescription>
          </DialogHeader>
          <div className="flex min-h-[45vh] max-h-[78vh] items-center justify-center overflow-auto bg-canvas p-4 sm:p-8">
            {preview ? <img src={compare ? sourceUrl : repairedPreviewUrl || preview.url} alt={t('imageStudio.outputLabel')} className="max-h-[70vh] max-w-full object-contain shadow-pop" /> : sourceUrl ? <img src={sourceUrl} alt={sourceLabel} className="max-h-[70vh] max-w-full object-contain shadow-pop" /> : null}
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

async function renderPrintSheet(file: File, options: Record<string, FieldValue>): Promise<Blob> {
  const image = await createImageBitmap(file);
  const canvas = new OffscreenCanvas(2480, 3508);
  const context = canvas.getContext('2d');
  if (!context) { image.close(); throw new Error('无法绘制打印预览'); }
  context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
  const two = options.size === 'two-inch'; const w = two ? 413 : 295; const h = two ? 579 : 413; const gap = 24; const margin = 59;
  const columns = Math.max(1, Math.floor((canvas.width - 2 * margin + gap) / (w + gap)));
  const rows = Math.max(1, Math.floor((canvas.height - 2 * margin + gap) / (h + gap)));
  const x0 = Math.floor((canvas.width - (columns * w + (columns - 1) * gap)) / 2);
  const y0 = Math.floor((canvas.height - (rows * h + (rows - 1) * gap)) / 2);
  for (let i = 0; i < columns * rows; i += 1) context.drawImage(image, x0 + (i % columns) * (w + gap), y0 + Math.floor(i / columns) * (h + gap), w, h);
  image.close(); return canvas.convertToBlob({ type: 'image/jpeg', quality: .8 });
}

function PreviewTile({ title, src, empty, onOpen, checkerboard = false }: { title: string; src: string; empty: boolean; onOpen: () => void; checkerboard?: boolean }) {
  const { t } = useI18n();
  return (
    <div className="min-w-0">
      <p className="mb-1.5 text-[11px] font-medium text-muted">{title}</p>
      <button
        type="button"
        aria-label={t('imageStudio.previewOpen')}
        disabled={empty}
        onClick={onOpen}
        className={`flex h-[248px] w-full items-center justify-center overflow-hidden rounded-control border border-line bg-canvas outline-none focus-visible:ring-2 focus-visible:ring-accent ${checkerboard ? 'checkerboard' : ''} ${empty ? 'cursor-default' : 'cursor-zoom-in'}`}
      >
        {src ? <img src={src} alt="" className="max-h-full max-w-full object-contain" /> : <span className="px-4 text-center text-[11px] leading-5 text-faint">{t('imageStudio.preview')}</span>}
      </button>
    </div>
  );
}

function isolatePerson(input: Uint8Array): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/person-segmentation.worker.ts', import.meta.url), { type: 'module' });
    const bytes = input.slice().buffer;
    worker.onmessage = (event: MessageEvent<{ bytes?: ArrayBuffer; error?: string }>) => {
      worker.terminate();
      if (event.data.error) reject(new Error(event.data.error));
      else if (event.data.bytes) resolve(new Blob([event.data.bytes], { type: 'image/png' }));
      else reject(new Error('没有生成透明背景图片'));
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || '人物识别失败'));
    };
    worker.postMessage({ id: 1, bytes }, [bytes]);
  });
}

async function renderPreview(file: File, tool: ToolId, options: Record<string, FieldValue>): Promise<{ blob: Blob; width: number; height: number }> {
  const image = await createImageBitmap(file);
  const longEdge = Math.max(image.width, image.height);
  const factor = Math.min(1, 900 / longEdge);
  const width = Math.max(1, Math.round(image.width * factor));
  const height = Math.max(1, Math.round(image.height * factor));
  const source = new OffscreenCanvas(width, height);
  const sourceContext = source.getContext('2d', { willReadFrequently: true });
  if (!sourceContext) throw new Error('预览图片不可用');
  sourceContext.drawImage(image, 0, 0, width, height);
  image.close();

  let outWidth = width;
  let outHeight = height;
  let crop: { x: number; y: number; width: number; height: number } | null = null;
  if (tool === 'image-id-photo') {
    const twoInch = options.size === 'two-inch';
    outWidth = twoInch ? 413 : 295;
    outHeight = twoInch ? 579 : 413;
    crop = photoFrame(sourceContext.getImageData(0, 0, width, height), width, height,
      outWidth / outHeight, Number(options.scale) || 100, Number(options.verticalOffset) || 0);
  }
  const output = new OffscreenCanvas(outWidth, outHeight);
  const context = output.getContext('2d');
  if (!context) throw new Error('无法绘制图片预览');
  if (tool === 'image-id-photo' || options.transparent === false) {
    context.fillStyle = String(options.background || '#ffffff');
    context.fillRect(0, 0, outWidth, outHeight);
  }
  if (crop) context.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, outWidth, outHeight);
  else context.drawImage(source, 0, 0, outWidth, outHeight);
  let blob: Blob;
  if (tool === 'image-id-photo') {
    const limitBytes = Math.max(10, Number(options.maxFileKb) || 100) * 1024;
    let smallest = Number.POSITIVE_INFINITY;
    let match: Blob | null = null;
    for (const quality of [0.94, 0.9, 0.86, 0.82, 0.78, 0.74, 0.7, 0.66, 0.62, 0.58, 0.54, 0.5, 0.46, 0.42, 0.38, 0.34, 0.3, 0.26, 0.22, 0.18, 0.14, 0.1]) {
      const encoded = await output.convertToBlob({ type: 'image/jpeg', quality });
      smallest = Math.min(smallest, encoded.size);
      if (encoded.size <= limitBytes) {
        match = encoded;
        break;
      }
    }
    if (!match) throw new Error(`最低画质仍为 ${Math.ceil(smallest / 1024)} KB，超过 ${Math.round(limitBytes / 1024)} KB 上限。`);
    blob = match;
  } else {
    blob = await output.convertToBlob({ type: options.transparent !== false ? 'image/png' : 'image/jpeg', quality: 0.94 });
  }
  return { blob, width: outWidth, height: outHeight };
}

function photoFrame(image: ImageData, width: number, height: number, aspect: number, scale: number, verticalOffset: number) {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((image.data[(y * width + x) * 4 + 3] ?? 0) < 24) continue;
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
  }
  if (right < left || bottom < top) return { x: 0, y: 0, width, height };
  const subjectWidth = right - left + 1;
  const subjectHeight = bottom - top + 1;
  const cropHeight = Math.max(subjectHeight * 0.62, subjectWidth / aspect) / (Math.min(130, Math.max(70, scale)) / 100);
  const cropWidth = cropHeight * aspect;
  const x = (left + right + 1) / 2 - cropWidth / 2;
  const y = top - cropHeight * 0.035 + cropHeight * (Math.min(20, Math.max(-20, verticalOffset)) / 100);
  return { x, y, width: cropWidth, height: cropHeight };
}

function decodeBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function mimeFor(name: string): string {
  const extension = name.split('.').pop()?.toLowerCase();
  return extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : 'image/jpeg';
}
