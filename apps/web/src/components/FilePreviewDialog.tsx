import { useEffect, useState } from 'react';
import { FileViewer } from '@open-file-viewer/react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@potools/ui';
import { useI18n } from '../i18n/index.tsx';
import { engineBridge, isTauri } from '../lib/tauri.ts';
import { FILE_VIEWER_PLUGINS, fileViewerSource } from '../lib/file-viewer.ts';
import { convertOfdToPdf } from '../lib/ofd-preview.ts';

/**
 * One preview surface for the whole app: input files and job artifacts both
 * open this dialog. The viewer's own toolbar (zoom, fit, rotate, page
 * navigation) is enabled, so scaling behaviour is identical everywhere.
 *
 * Source resolution order: an in-memory `File` (browser pick), inline base64
 * (in-memory artifacts), then a desktop path read through the binary IPC —
 * bytes never take a base64 detour for on-disk files.
 */
export interface PreviewTarget {
  name: string;
  file?: File | null;
  path?: string | null;
  dataBase64?: string;
}

export function FilePreviewDialog({ target, onClose }: { target: PreviewTarget | null; onClose: () => void }) {
  const { t } = useI18n();
  const [source, setSource] = useState<File | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setSource(null);
    setFailed(false);
    if (!target) return;
    let alive = true;
    void (async () => {
      try {
        let bytes: Uint8Array | null = null;
        if (target.file) {
          bytes = new Uint8Array(await target.file.arrayBuffer());
        } else if (target.dataBase64) {
          const binary = atob(target.dataBase64);
          bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        } else if (target.path && isTauri()) {
          const bridge = await engineBridge();
          bytes = new Uint8Array(await bridge.invoke<ArrayBuffer>('read_file_binary', { path: target.path }));
        }
        if (!alive) return;
        if (!bytes) {
          setFailed(true);
          return;
        }
        let name = target.name;
        if (/\.ofd$/i.test(name)) {
          // The generic viewer's OFD plugin misplaces text; route OFD through
          // the app's own engine to PDF (fonts included) and preview that. If
          // the conversion fails, fall back to the raw file rather than
          // showing nothing.
          try {
            const pdf = await convertOfdToPdf(bytes, name);
            if (!alive) return;
            if (pdf) {
              bytes = pdf;
              name = name.replace(/\.ofd$/i, '.pdf');
            }
          } catch {
            if (!alive) return;
          }
        }
        setSource(fileViewerSource(bytes, name));
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [target]);

  return (
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="flex h-[min(92vh,58rem)] w-[min(96vw,84rem)] max-w-none flex-col overflow-hidden p-0" aria-describedby="file-preview-description">
        <DialogHeader className="shrink-0 border-b border-line px-5 py-3 pr-12">
          <DialogTitle className="truncate text-[14px]">{target?.name}</DialogTitle>
          <DialogDescription id="file-preview-description" className="truncate">
            {failed ? t('preview.unavailable') : t('preview.hint')}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 bg-canvas">
          {source ? (
            <FileViewer
              file={source}
              fileName={target?.name}
              height="100%"
              theme="auto"
              toolbar
              plugins={FILE_VIEWER_PLUGINS}
              fallback="inline"
              className="h-full w-full"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-[12px] text-faint">
              {failed ? t('preview.unavailable') : t('preview.loading')}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
