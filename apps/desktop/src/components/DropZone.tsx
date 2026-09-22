import { useCallback, useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { Icon } from '@potools/ui';
import { Button } from '@potools/ui';
import { useI18n } from '../i18n/index.tsx';
import { filesFromDataTransfer, pickFiles, type PickedFile } from '../lib/files.ts';
import { isTauri, ACCEPT_EXTENSIONS } from '../lib/tauri.ts';
import type { AcceptKind } from '../lib/tauri.ts';

export function useNativeDrop(enabled: boolean, onPaths: (paths: string[]) => void): void {
  useEffect(() => {
    if (!enabled || !isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const { getCurrentWebview } = await import('@tauri-apps/api/webview');
      const stop = await getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type === 'drop') onPaths(event.payload.paths);
      });
      if (disposed) stop();
      else unlisten = stop;
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [enabled, onPaths]);
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
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

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
    [onFiles],
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
      <Button
        type="button"
        variant="outline"
        onClick={browse}
        aria-busy={busy}
        className={`group h-auto w-full flex-col gap-2 rounded-card border-dashed bg-transparent text-center text-ink shadow-none hover:bg-accent-soft/40 active:translate-y-0 ${
          over ? 'drag-over border-accent' : 'border-line hover:border-accent/60'
        } ${compact ? 'px-3 py-4' : 'px-4 py-9'}`}
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
      </Button>
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        multiple={multiple}
        accept={ACCEPT_EXTENSIONS[accept].mime}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []).map((file) => ({
            id: `${file.name}-${file.lastModified}-${file.size}`,
            name: file.name,
            size: file.size,
            path: null,
            file,
          }));
          if (files.length) onFiles(files, null as unknown as DataTransfer);
          event.target.value = '';
        }}
      />
    </div>
  );
}
