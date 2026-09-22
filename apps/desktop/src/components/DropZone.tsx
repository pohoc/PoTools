import { useCallback, useEffect, useState } from 'react';
import type { DragEvent } from 'react';
import { Icon } from '@potools/ui';
import { useI18n } from '../i18n/index.tsx';
import { filesFromDataTransfer, fromPaths, pickFiles, type PickedFile } from '../lib/files.ts';
import { isTauri, ACCEPT_EXTENSIONS, type AcceptKind } from '../lib/tauri.ts';

/**
 * Tauri intercepts HTML5 drag & drop (dragDropEnabled), so on the desktop the
 * drop zone is driven from native webview events — including the hover state,
 * which the DOM events can never provide there. Browser builds keep the DOM events.
 */
function useDragOver(onDropPaths: (paths: string[]) => void): [boolean, (over: boolean) => void] {
  const [over, setOver] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const { getCurrentWebview } = await import('@tauri-apps/api/webview');
      const stop = await getCurrentWebview().onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === 'drop') {
          setOver(false);
          onDropPaths(payload.paths);
        } else {
          setOver(payload.type === 'over');
        }
      });
      if (disposed) stop();
      else unlisten = stop;
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [onDropPaths]);

  return [over, setOver];
}

export function DropZone({
  accept,
  multiple,
  compact,
  onFiles,
  busy,
}: {
  accept: AcceptKind;
  multiple: boolean;
  compact?: boolean;
  onFiles: (files: PickedFile[], transfer: DataTransfer) => void;
  busy?: boolean;
}) {
  const { t } = useI18n();
  const [over, setOver] = useDragOver(
    useCallback(
      (paths: string[]) => {
        const files = fromPaths(paths);
        if (files.length) onFiles(files, null as unknown as DataTransfer);
      },
      [onFiles],
    ),
  );

  const browse = useCallback(() => {
    void pickFiles(accept, multiple).then((files) => {
      if (files.length) onFiles(files, null as unknown as DataTransfer);
    });
  }, [accept, multiple, onFiles]);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setOver(false);
      if (isTauri()) return;
      const files = filesFromDataTransfer(event.dataTransfer);
      if (files.length) onFiles(files, event.dataTransfer);
    },
    [onFiles, setOver],
  );

  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        if (!isTauri()) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={handleDrop}
      className="w-full"
    >
      <div
        role="button"
        tabIndex={busy ? -1 : 0}
        aria-busy={busy}
        aria-label={compact ? t('drop.append') : t('drop.browse')}
        onClick={() => { if (!busy) browse(); }}
        onKeyDown={(event) => {
          if (!busy && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            browse();
          }
        }}
        className={`tool-drop-zone group flex w-full cursor-pointer flex-col items-center justify-center rounded-control border border-dashed text-center outline-none transition focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30 ${
          over ? 'drag-over border-accent bg-accent-soft/35' : 'border-line bg-surface hover:border-accent/60'
        } ${compact ? 'gap-2 px-3 py-4' : 'gap-2.5 px-4 py-6'}`}
      >
        <span
          className={`flex items-center justify-center rounded-full bg-raised text-muted transition group-hover:bg-accent-soft group-hover:text-accent ${
            compact ? 'h-8 w-8' : 'h-11 w-11'
          }`}
        >
          <Icon name={busy ? 'spinner' : 'plus'} size={compact ? 15 : 19} className={busy ? 'animate-spin' : ''} />
        </span>
        <span className={`font-semibold text-ink ${compact ? 'text-[12.5px]' : 'text-[14px]'}`}>
          {compact ? t('drop.append') : t('drop.title')}
        </span>
        {!compact ? <span className="text-[12px] leading-5 text-faint">{t(`drop.hint.${accept}`)}</span> : null}
      </div>
    </div>
  );
}
