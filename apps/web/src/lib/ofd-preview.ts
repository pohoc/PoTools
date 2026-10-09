import { callEmbeddedRpc } from './embedded-engine.ts';
import { systemFontRuntimeData } from './file-runtime-data.ts';
import { encodeMarkupFontRuntimeData } from './transport-shared.ts';

/**
 * Renders an OFD document to PDF bytes with the app's own engine.
 *
 * The generic viewer's OFD plugin ignores TextObject bounds and piles text at
 * the page origin, so previews of real documents come out garbled; our engine
 * applies them (the same code path as the OFD→PDF tool). Fonts come from the
 * shared runtime-data builder — bundled Noto in the browser, system font
 * candidates on the desktop.
 */
export async function convertOfdToPdf(bytes: Uint8Array, name: string): Promise<Uint8Array | null> {
  // Wire contract: runtimeData crosses to wasm as JSON, so font bytes must be
  // base64 strings (`bytesBase64`), never raw Uint8Arrays — a raw array makes
  // the whole dispatch deserialization fail with `invalid type: byte array`.
  const runtimeData = encodeMarkupFontRuntimeData(await systemFontRuntimeData());
  const reply = await callEmbeddedRpc('job.submit', {
    job: {
      id: `ofd-preview-${Date.now().toString(36)}`,
      tool: 'ofd-to-pdf',
      label: 'preview',
      options: {},
      createdAt: Date.now(),
    },
  }, { inputs: [{ id: 'ofd-preview', name, path: null, bytes }], runtimeData });
  const artifact = reply.jobResult?.artifacts?.[0];
  return artifact?.bytes instanceof Uint8Array ? artifact.bytes : null;
}
