import { useEffect, useMemo, useRef, useState } from 'react';
import type { FileRef, PageThumb } from 'core';
import { toFileRef, type PickedFile } from './files.ts';
import { useEngine } from '../stores/engine.ts';

const THUMB_CACHE = new Map<string, PageThumb>();
const REF_CACHE = new Map<string, Promise<FileRef>>();
// Large page renders are much larger than card thumbnails. Keep only a few
// high-resolution pages so opening several previews cannot retain hundreds
// of megabytes of base64 image data in the renderer.
const MAX_THUMB_CACHE_ENTRIES = 16;

function key(fileId: string, page: number, width: number): string {
  return `${fileId}:${page}:${width}`;
}

function maxCacheEntries(width: number): number {
  return width > 600 ? 3 : MAX_THUMB_CACHE_ENTRIES;
}

function fileRefFor(picked: PickedFile): Promise<FileRef> {
  let cached = REF_CACHE.get(picked.id);
  if (!cached) {
    cached = toFileRef(picked);
    REF_CACHE.set(picked.id, cached);
    while (REF_CACHE.size > 8) {
      const oldest = REF_CACHE.keys().next().value;
      if (!oldest || oldest === picked.id) break;
      REF_CACHE.delete(oldest);
    }
  }
  return cached;
}

export function clearThumbCache(): void {
  THUMB_CACHE.clear();
  REF_CACHE.clear();
}

function cacheThumb(id: string, thumb: PageThumb, width: number): void {
  THUMB_CACHE.delete(id);
  THUMB_CACHE.set(id, thumb);
  const limit = maxCacheEntries(width);
  while (THUMB_CACHE.size > limit) {
    const oldest = THUMB_CACHE.keys().next().value;
    if (!oldest) break;
    THUMB_CACHE.delete(oldest);
  }
}

/**
 * Lazily fetches page thumbnails in batches. Requests are tracked by key so a
 * re-render never abandons an in-flight batch (which used to leave pages blank
 * forever), and failures are retried on the next pass.
 */
export function usePageThumbs(
  files: PickedFile[],
  wanted: Array<{ fileId: string; page: number }>,
  width = 168,
): { thumbs: Record<string, PageThumb>; loading: boolean } {
  const call = useEngine((state) => state.call);
  const [thumbs, setThumbs] = useState<Record<string, PageThumb>>({});
  const [loading, setLoading] = useState(false);
  const requested = useRef(new Set<string>());

  useEffect(() => {
    const fresh: Record<string, PageThumb> = {};
    const active = new Set(wanted.map((item) => item.fileId));
    const wantedKeys = new Set(wanted.map((item) => key(item.fileId, item.page, width)));
    for (const [id, thumb] of THUMB_CACHE) {
      const [fileId, page] = id.split(':');
      if (!active.has(fileId ?? '')) continue;
      const wantedKey = key(fileId ?? '', Number(page), width);
      if (wantedKeys.has(wantedKey)) fresh[wantedKey] = thumb;
    }
    for (const item of wanted) {
      const thumbKey = key(item.fileId, item.page, width);
      const cached = THUMB_CACHE.get(thumbKey);
      if (cached) fresh[thumbKey] = cached;
    }
    setThumbs(fresh);
    for (const id of [...requested.current]) {
      const fileId = id.split(':')[0];
      if (!fileId || !active.has(fileId)) requested.current.delete(id);
    }
  }, [wanted, width]);

  const signature = useMemo(() => {
    const missing: string[] = [];
    for (const item of wanted) {
      const id = key(item.fileId, item.page, width);
      if (!THUMB_CACHE.has(id) && !requested.current.has(id)) missing.push(id);
    }
    return missing.sort().join('|');
  }, [wanted, width]);

  useEffect(() => {
    if (!signature) return;
    const byFile = new Map<string, number[]>();
    for (const id of signature.split('|')) {
      const [fileId, pageValue] = id.split(':');
      if (!fileId || !pageValue) continue;
      const list = byFile.get(fileId) ?? [];
      list.push(Number(pageValue));
      byFile.set(fileId, list);
    }
    let alive = true;
    setLoading(true);
    void (async () => {
      for (const [fileId, pages] of byFile) {
        const picked = files.find((file) => file.id === fileId);
        if (!picked) continue;
        for (let start = 0; start < pages.length; start += 8) {
          const chunk = pages.slice(start, start + 8);
          chunk.forEach((page) => requested.current.add(key(fileId, page, width)));
          try {
            const result = await call<PageThumb[]>('page.thumbs', {
              file: await fileRefFor(picked),
              pages: chunk,
              width,
            });
            setThumbs((prev) => {
              const next = { ...prev };
              for (const thumb of result) {
                const thumbKey = key(fileId, thumb.page, width);
                cacheThumb(thumbKey, thumb, width);
                next[thumbKey] = thumb;
              }
              return next;
            });
          } catch {
            chunk.forEach((page) => requested.current.delete(key(fileId, page, width)));
          }
        }
      }
      if (alive) setLoading(false);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, files, call, width]);

  return { thumbs, loading };
}
