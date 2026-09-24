import type { PDFDocument, PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

export interface SystemFontResource {
  name: string;
  bytes: Uint8Array;
}

type FontFace = ReturnType<typeof fontkit.create> & { hasGlyphForCodePoint(codePoint: number): boolean };

const parsedFaces = new WeakMap<Uint8Array, FontFace[]>();

export function systemFontResources(runtimeData?: Record<string, unknown>): SystemFontResource[] {
  if (!Array.isArray(runtimeData?.systemFonts)) return [];
  return (runtimeData.systemFonts as SystemFontResource[]).filter(
    (font) => typeof font?.name === 'string' && font.bytes instanceof Uint8Array,
  );
}

export function systemFontsForText(text: string, resources: SystemFontResource[]): Array<{ resource: SystemFontResource; face: FontFace }> {
  const codePoints = [...text]
    .filter((character) => !/\s/u.test(character))
    .map((character) => character.codePointAt(0)!)
    .filter((codePoint, index, all) => all.indexOf(codePoint) === index);
  const matches: Array<{ resource: SystemFontResource; face: FontFace }> = [];
  for (const resource of resources) {
    try {
      let faces = parsedFaces.get(resource.bytes);
      if (!faces) {
        const parsed = fontkit.create(resource.bytes) as FontFace & { fonts?: FontFace[] };
        faces = parsed.fonts?.length ? parsed.fonts : [parsed];
        parsedFaces.set(resource.bytes, faces);
      }
      const face = faces.find((candidate) => codePoints.every((codePoint) => candidate.hasGlyphForCodePoint(codePoint)));
      if (face) matches.push({ resource, face });
    } catch {
      // Try the next host-discovered font.
    }
  }
  return matches;
}

export function systemFontForText(text: string, resources: SystemFontResource[]): { resource: SystemFontResource; face: FontFace } | null {
  return systemFontsForText(text, resources)[0] ?? null;
}

export async function embedSystemFont(doc: PDFDocument, text: string, resources: SystemFontResource[]): Promise<PDFFont> {
  let lastError: unknown;
  for (const match of systemFontsForText(text, resources)) {
    try {
      doc.registerFontkit({ create: () => match.face });
      return await doc.embedFont(match.resource.bytes, { subset: true });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('No embeddable system font contains all required glyphs');
}
