import { useEffect, useState } from 'react';
import type { DirListing } from 'core';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Icon, Input } from '@potools/ui';
import { useI18n } from '../i18n/index.tsx';
import { useEngine } from '../stores/engine.ts';

const QUICK_KEYS: Record<DirListing['quick'][number]['id'], string> = {
  home: 'picker.home',
  documents: 'picker.documents',
  downloads: 'picker.downloads',
  desktop: 'picker.desktop',
};

/**
 * Folder chooser for the browser transport, where no native dialog exists.
 * The engine lists one level at a time, so nothing here walks the tree eagerly.
 */
export function DirectoryPicker({
  open,
  initialPath,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  initialPath?: string | null;
  onOpenChange: (open: boolean) => void;
  onPick: (path: string) => void;
}) {
  const { t } = useI18n();
  const call = useEngine((state) => state.call);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [manual, setManual] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const browse = (path: string | null) => {
    setPending(true);
    setError(null);
    call<DirListing>('fs.browse', { path })
      .then((next) => {
        setListing(next);
        setManual(next.requested);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setPending(false));
  };

  useEffect(() => {
    if (!open) return;
    let active = true;
    setPending(true);
    setError(null);
    call<DirListing>('fs.browse', { path: initialPath || null })
      .then((next) => {
        if (!active) return;
        setListing(next);
        setManual(next.requested);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (active) setPending(false);
      });
    return () => {
      active = false;
    };
  }, [open, initialPath, call]);

  const missing = !!listing && listing.requested !== listing.path;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex w-[min(94vw,36rem)] max-w-none flex-col overflow-hidden p-0">
        <DialogHeader className="border-b border-line px-5 py-3.5 pr-12">
          <DialogTitle className="text-[14px]">{t('settings.choose')}</DialogTitle>
          <DialogDescription className="truncate font-mono text-[11.5px]" title={listing?.requested ?? ''}>
            {listing?.requested ?? '—'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2 px-5 py-2.5">
          <Input
            className="h-8 min-w-0 flex-1 font-mono text-[12px]"
            value={manual}
            spellCheck={false}
            aria-label={t('settings.choose')}
            onChange={(event) => setManual(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') browse(manual || null);
            }}
          />
          <Button type="button" variant="outline" size="sm" className="h-8 shrink-0 rounded-control px-2.5 text-[11.5px]" onClick={() => browse(manual || null)}>
            {t('common.go')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-8 w-8 shrink-0 rounded-control"
            disabled={!listing?.parent}
            aria-label={t('picker.up')}
            title={t('picker.up')}
            onClick={() => browse(listing?.parent ?? null)}
          >
            <Icon name="chevronRight" size={14} className="rotate-180" />
          </Button>
        </div>

        {listing?.quick.length ? (
          <div className="flex flex-wrap items-center gap-1.5 px-5 pb-2.5">
            <span className="shrink-0 text-[11.5px] text-faint">{t('picker.quick')}</span>
            {listing.quick.map((entry) => (
              <Button
                key={entry.id}
                type="button"
                variant="outline"
                size="sm"
                className="option-chip h-7 rounded-control px-2 text-[11.5px]"
                aria-pressed={listing.path === entry.path}
                onClick={() => browse(entry.path)}
              >
                {t(QUICK_KEYS[entry.id])}
              </Button>
            ))}
          </div>
        ) : null}

        <div className="dir-picker-list max-h-[42vh] min-h-[9rem] overflow-auto border-t border-line px-2.5 py-2">
          {error ? <p className="px-2 py-3 text-[12px] text-bad" role="alert">{error}</p> : null}
          {pending ? <p className="px-2 py-3 text-[12px] text-faint">{t('picker.loading')}</p> : null}
          {!pending && !error && !listing?.dirs.length ? (
            <p className="px-2 py-3 text-[12px] text-faint">{t('picker.empty')}</p>
          ) : null}
          {!pending
            ? listing?.dirs.map((dir) => (
              <button
                key={dir.path}
                type="button"
                onClick={() => browse(dir.path)}
                className="flex h-8 w-full min-w-0 items-center gap-2 rounded-control px-2 text-left text-[12.5px] text-ink outline-none transition hover:bg-raised focus-visible:ring-2 focus-visible:ring-accent/35"
              >
                <Icon name="folder" size={14} className="shrink-0 text-faint" />
                <span className="min-w-0 flex-1 truncate">{dir.name}</span>
                <Icon name="chevronRight" size={13} className="shrink-0 text-faint" />
              </button>
            ))
            : null}
        </div>

        {missing ? <p className="px-5 pb-2 text-[11.5px] leading-4 text-muted">{t('picker.missingHint')}</p> : null}

        <DialogFooter className="border-t border-line px-5 py-3">
          <Button type="button" variant="ghost" size="sm" className="rounded-control" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            className="rounded-control"
            disabled={!listing}
            onClick={() => {
              if (!listing) return;
              onPick(listing.requested);
              onOpenChange(false);
            }}
          >
            {t('picker.pick')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
