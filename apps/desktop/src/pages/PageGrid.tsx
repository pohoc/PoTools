import { Icon } from '@potools/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PageThumb, ProbedPdf } from 'core';
import { Button, EmptyState, IconButton } from '@potools/ui';
import { useI18n } from '../i18n/index.tsx';
import { usePageThumbs } from '../lib/usePageThumbs.ts';
import type { PickedFile } from '../lib/files.ts';

export interface Slot {
  key: string;
  fileId: string;
  page: number;
  rotation: number;
}

const THUMB_WIDTH = 168;

export function slotsFromProbes(files: PickedFile[], probes: Record<string, ProbedPdf>): Slot[] {
  return files.flatMap((file) => {
    const probe = probes[file.id];
    if (!probe) return [];
    return probe.pages.map((page) => ({
      key: `${file.id}:${page.page}:0`,
      fileId: file.id,
      page: page.page,
      rotation: 0,
    }));
  });
}

export function PageGrid({
  files,
  probes,
  slots,
  onChange,
}: {
  files: PickedFile[];
  probes: Record<string, ProbedPdf>;
  slots: Slot[];
  onChange: (next: Slot[]) => void;
}) {
  const { t, tf } = useI18n();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  const wanted = useMemo(
    () => slots.map((slot) => ({ fileId: slot.fileId, page: slot.page })),
    [slots],
  );
  const { thumbs } = usePageThumbs(files, wanted, THUMB_WIDTH);
  const loading = wanted.some((item) => !thumbs[`${item.fileId}:${item.page}`]);



  const targets = selected.size ? slots.filter((slot) => selected.has(slot.key)) : slots;

  const rotate = useCallback(
    (delta: number) => {
      onChange(
        slots.map((slot) =>
          selected.has(slot.key) || !selected.size
            ? { ...slot, rotation: (((slot.rotation + delta) % 360) + 360) % 360 }
            : slot,
        ),
      );
    },
    [onChange, selected, slots],
  );

  const duplicate = useCallback(() => {
    if (!targets.length) return;
    const out: Slot[] = [];
    for (const slot of slots) {
      out.push(slot);
      if (selected.has(slot.key) || !selected.size) {
        out.push({ ...slot, key: `${slot.fileId}:${slot.page}:${out.length}` });
      }
    }
    onChange(out);
  }, [onChange, selected, slots, targets.length]);

  const remove = useCallback(() => {
    if (!selected.size) return;
    onChange(slots.filter((slot) => !selected.has(slot.key)));
    setSelected(new Set());
  }, [onChange, selected, slots]);

  const move = useCallback(
    (from: number, to: number) => {
      if (from === to) return;
      const next = [...slots];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved as Slot);
      onChange(next);
    },
    [onChange, slots],
  );

  const toggle = (key: string, additive: boolean) => {
    setSelected((prev) => {
      const next = new Set(additive ? prev : []);
      if (prev.has(key) && additive) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (!slots.length) {
    return (
      <EmptyState
        icon="layout-grid"
        title={files.length ? t('file.reading') : t('drop.title')}
        hint={files.length ? t('organizer.empty') : t('organizer.hint')}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[12px] text-muted">{tf('organizer.pages', { count: slots.length })}</span>
        {selected.size ? (
          <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11.5px] text-accent">
            {tf('organizer.selected', { count: selected.size })}
          </span>
        ) : null}
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <Button size="sm" variant="ghost" icon="reset" onClick={() => onChange(slotsFromProbes(files, probes))}>
            {t('organizer.reset')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon="check"
            onClick={() =>
              setSelected(selected.size === slots.length ? new Set() : new Set(slots.map((slot) => slot.key)))
            }
          >
            {t('organizer.selectAll')}
          </Button>
          <span className="mx-1 h-4 w-px bg-line" />
          <Button size="sm" variant="ghost" icon="rotate-cw" onClick={() => rotate(-90)} title={t('organizer.rotateLeft')}>
            {t('organizer.rotateLeft')}
          </Button>
          <Button size="sm" variant="ghost" icon="rotate-cw" onClick={() => rotate(90)} title={t('organizer.rotateRight')}>
            {t('organizer.rotateRight')}
          </Button>
          <Button size="sm" variant="ghost" icon="copy" onClick={duplicate}>
            {t('organizer.duplicate')}
          </Button>
          <Button size="sm" variant="danger" icon="trash" onClick={remove} disabled={!selected.size}>
            {t('organizer.remove')}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(124px,1fr))] gap-2.5">
        {slots.map((slot, index) => {
          const thumb = thumbs[`${slot.fileId}:${slot.page}`];
          const isSelected = selected.has(slot.key);
          const source = files.find((file) => file.id === slot.fileId);
          return (
            <figure
              key={slot.key}
              draggable
              onDragStart={() => setDragFrom(index)}
              onDragOver={(event) => {
                if (dragFrom === null) return;
                event.preventDefault();
                setDragOver(index);
              }}
              onDrop={() => {
                if (dragFrom !== null) move(dragFrom, index);
                setDragFrom(null);
                setDragOver(null);
              }}
              onDragEnd={() => {
                setDragFrom(null);
                setDragOver(null);
              }}
              onClick={(event) => toggle(slot.key, event.metaKey || event.ctrlKey || event.shiftKey)}
              className={`group relative flex cursor-pointer flex-col overflow-hidden rounded-control border bg-surface transition ${
                isSelected ? 'border-accent ring-2 ring-accent/25' : 'border-line hover:border-accent/50'
              } ${dragOver === index && dragFrom !== null ? 'page-drop-line' : ''} ${
                dragFrom === index ? 'opacity-50' : ''
              }`}
            >
              <div className="flex aspect-[1/1.25] items-center justify-center bg-raised p-1.5">
                {thumb ? (
                  <img
                    src={thumb.dataUrl}
                    alt={`p${slot.page}`}
                    draggable={false}
                    className="max-h-full max-w-full rounded-xs bg-white shadow-control transition-transform duration-200"
                    style={{ transform: `rotate(${slot.rotation}deg) scale(${slot.rotation % 180 === 90 ? 0.78 : 1})` }}
                  />
                ) : (
                  <span className="flex flex-col items-center gap-1 text-faint">
                    {loading ? <Icon name="spinner" size={15} className="animate-spin" /> : <Icon name="file" size={15} />}
                    <span className="font-mono text-[10px]">{slot.page}</span>
                  </span>
                )}
              </div>

              <figcaption className="flex items-center gap-1 border-t border-line px-1.5 py-1">
                <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted" title={source?.name}>
                  {slot.page}
                </span>
                {slot.rotation ? (
                  <span className="shrink-0 rounded bg-accent-soft px-1 text-[10px] text-accent">{slot.rotation}°</span>
                ) : null}
                {files.length > 1 ? (
                  <span className="shrink-0 truncate text-[10px] text-faint" title={source?.name}>
                    {files.findIndex((file) => file.id === slot.fileId) + 1}
                  </span>
                ) : null}
              </figcaption>

              <span className="absolute right-1 top-1 flex gap-0.5 opacity-0 transition group-hover:opacity-100">
                <IconButton
                  icon="rotate-cw"
                  size={12}
                  label={t('organizer.rotateRight')}
                  className="!h-6 !w-6 bg-surface/90 backdrop-blur"
                  onClick={(event) => {
                    event.stopPropagation();
                    onChange(
                      slots.map((item) =>
                        item.key === slot.key ? { ...item, rotation: (item.rotation + 90) % 360 } : item,
                      ),
                    );
                  }}
                />
                <IconButton
                  icon="close"
                  size={12}
                  label={t('organizer.remove')}
                  className="!h-6 !w-6 bg-surface/90 text-bad backdrop-blur"
                  onClick={(event) => {
                    event.stopPropagation();
                    onChange(slots.filter((item) => item.key !== slot.key));
                  }}
                />
              </span>
            </figure>
          );
        })}
      </div>
      <p className="text-[11.5px] leading-5 text-faint">{t('organizer.hint')}</p>
    </div>
  );
}
