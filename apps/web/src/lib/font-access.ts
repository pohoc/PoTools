/**
 * Bundled default CJK font for browser mode. Browsers cannot read system
 * font files, so PDF text embedding uses the OFL-licensed Noto Sans SC that
 * ships with the app assets (fetched lazily, cached for the session).
 */
let bundledPromise: Promise<Uint8Array | null> | null = null;

export function bundledCjkFontUrl(): string {
  return `${import.meta.env.BASE_URL}fonts/NotoSansSC-Regular.ttf`;
}

export function fetchBundledCjkFont(): Promise<Uint8Array | null> {
  bundledPromise ??= fetch(bundledCjkFontUrl())
    .then((response) => (response.ok ? response.arrayBuffer() : Promise.reject(new Error(`HTTP ${response.status}`))))
    .then((buffer) => new Uint8Array(buffer))
    .catch(() => null);
  return bundledPromise;
}

/** System-style font entry for runtimeData; empty when the font is unavailable. */
export async function bundledSystemFonts(): Promise<Array<{ name: string; bytes: Uint8Array }>> {
  const bytes = await fetchBundledCjkFont();
  return bytes ? [{ name: 'Noto Sans SC', bytes }] : [];
}
