export interface PptxInput {
  /** One entry per slide, sized in inches. */
  slides: Array<{
    widthIn: number;
    heightIn: number;
    image: Uint8Array;
    lines: Array<{ text: string; xIn: number; yIn: number; wIn: number; hIn: number; size: number; bold: boolean; color?: string }>;
  }>;
  title: string;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/** Creates a presentation from rendered page backgrounds and searchable text. */
export async function writePptx(input: PptxInput): Promise<Uint8Array> {
  const mod = await import('pptxgenjs');
  const PptxGenJS = mod.default ?? (mod as unknown as { PptxGenJS: new () => any });
  const pptx: any = typeof PptxGenJS === 'function' ? new PptxGenJS() : (PptxGenJS as any);
  pptx.title = input.title;
  pptx.author = 'PoTools';
  const first = input.slides[0];
  if (first) pptx.defineLayout({ name: 'PDFPAGE', width: first.widthIn, height: first.heightIn });
  pptx.layout = 'PDFPAGE';

  for (const slide of input.slides) {
    const target = pptx.addSlide();
    target.addImage({
      data: `image/png;base64,${base64(slide.image)}`,
      x: 0,
      y: 0,
      w: slide.widthIn,
      h: slide.heightIn,
    });
    for (const line of slide.lines) {
      target.addText(
        [{ text: line.text, options: { bold: line.bold, fontSize: Math.max(5, Math.round(line.size * 0.72)) } }],
        {
          x: line.xIn,
          y: line.yIn,
          w: line.wIn,
          h: line.hIn,
          color: line.color ?? '000000',
          transparency: 0,
          valign: 'top',
          fit: 'shrink',
        },
      );
    }
  }
  const written = await pptx.write({ outputType: 'arraybuffer' });
  return new Uint8Array(written as ArrayBuffer);
}
