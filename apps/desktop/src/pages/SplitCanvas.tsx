import { useMemo, useState } from 'react';
import type { ProbedPdf } from 'core';
import { Button, Icon } from '@potools/ui';
import { useI18n } from '../i18n/index.tsx';
import { usePageThumbs } from '../lib/usePageThumbs.ts';
import type { PickedFile } from '../lib/files.ts';

/** Cut positions are 1-based page numbers: "split after this page". */
export function groupsFromCuts(cuts: number[], pageCount: number): number[][] {
  const points = [...new Set(cuts.filter((cut) => cut >= 1 && cut < pageCount))].sort((a, b) => a - b);
  const groups: number[][] = [];
  let start = 1;
  for (const point of points) {
    groups.push(range(start, point));
    start = point + 1;
  }
  if (start <= pageCount) groups.push(range(start, pageCount));
  return groups.filter((group) => group.length);
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let page = from; page <= to; page += 1) out.push(page);
  return out;
}

export function SplitCanvas({
  file,
  probe,
  cuts,
  onChange,
}: {
  file: PickedFile;
  probe?: ProbedPdf;
  cuts: number[];
  onChange: (cuts: number[]) => void;
}) {
  const { t, tf } = useI18n();
  const [dragCut, setDragCut] = useState<number | null>(null);
  const pageCount = probe?.pageCount ?? 0;

  const wanted = useMemo(
    () => Array.from({ length: pageCount }, (_, index) => ({ fileId: file.id, page: index + 1 })),
    [file.id, pageCount],
  );
  const { thumbs, loading } = usePageThumbs(wanted.length ? [file] : [], wanted, 128);
  const groups = useMemo(() => groupsFromCuts(cuts, pageCount), [cuts, pageCount]);

  if (!pageCount) {
    return (
      <p className="px-1 py-4 text-[12px] text-faint">
        {file ? `${file.name} · ${t('file.reading')}` : t('organizer.empty')}
      </p>
    );
  }

  const toggle = (position: number) => {
    onChange(cuts.includes(position) ? cuts.filter((cut) => cut !== position) : [...cuts, position]);
  };

  const move = (from: number, to: number) => {
    if (from === to) return;
    onChange([...cuts.filter((cut) => cut !== from), to].sort((a, b) => a - b));
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[12px] text-muted">{tf('organizer.pages', { count: pageCount })}</span>
        <span className="text-[12px] text-faint">·</span>
        <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11.5px] text-accent">
          {tf('result.artifacts', { count: groups.length })}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            icon="scissors"
            onClick={() => onChange(rangeEvery(pageCount, 2))}
            title={tf('split.everyN', { n: 2 })}
          >
            {tf('split.everyN', { n: 2 })}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon="scissors"
            onClick={() => onChange(rangeEvery(pageCount, 3))}
            title={tf('split.everyN', { n: 3 })}
          >
            {tf('split.everyN', { n: 3 })}
          </Button>
          <Button size="sm" variant="ghost" icon="reset" onClick={() => onChange([])}>
            {t('common.reset')}
          </Button>
        </div>
      </div>

      <div className="flex items-stretch gap-0 overflow-x-auto rounded-control border border-line bg-raised p-2">
        {Array.from({ length: pageCount }, (_, index) => index + 1).map((page) => {
          const thumb = thumbs[`${file.id}:${page}`];
          const cutBefore = cuts.includes(page - 1) && page > 1;
          return (
            <div key={page} className="flex items-stretch">
              <Button
                type="button"
                variant="ghost"
                aria-label={t('split.cutHere')}
                title={t('split.cutHere')}
                draggable={cutBefore}
                onDragStart={() => cutBefore && setDragCut(page - 1)}
                onDragOver={(event) => page > 1 && event.preventDefault()}
                onDrop={() => {
                  if (dragCut !== null && page > 1) move(dragCut, page - 1);
                  setDragCut(null);
                }}
                disabled={page === 1}
                aria-pressed={cuts.includes(page - 1)}
                onClick={() => page > 1 && toggle(page - 1)}
                className={`group relative h-auto w-4 shrink-0 justify-center rounded-none border-0 bg-transparent p-0 active:translate-y-0 hover:bg-transparent disabled:cursor-default ${
                  page === 1 ? 'opacity-0' : ''
                }`}
              >
                <span
                  className={`h-full w-[3px] rounded-full transition ${
                    cutBefore
                      ? 'cursor-grab bg-accent group-hover:brightness-110'
                      : 'bg-transparent group-hover:bg-accent/35'
                  }`}
                />
                {cutBefore ? (
                  <span className="absolute -top-0.5 left-1/2 flex h-4 w-4 -translate-x-1/2 items-center justify-center rounded-full bg-accent text-accent-ink shadow">
                    <Icon name="close" size={9} />
                  </span>
                ) : (
                  page > 1 && (
                    <span className="absolute left-1/2 top-1/2 flex h-4 w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-surface text-accent opacity-0 shadow transition group-hover:opacity-100">
                      <Icon name="plus" size={10} />
                    </span>
                  )
                )}
              </Button>
              <figure className="flex w-[86px] shrink-0 flex-col overflow-hidden rounded-[6px] border border-line bg-surface">
                <div className="flex aspect-[1/1.25] items-center justify-center bg-raised p-1">
                  {thumb ? (
                    <img
                      src={thumb.dataUrl}
                      alt={`p${page}`}
                      draggable={false}
                      className="max-h-full max-w-full rounded-[3px] bg-white shadow-[0_1px_2px_rgb(15_23_42/0.16)]"
                    />
                  ) : (
                    <Icon name={loading ? 'spinner' : 'file'} size={14} className={loading ? 'animate-spin text-faint' : 'text-faint'} />
                  )}
                </div>
                <figcaption className="border-t border-line py-[3px] text-center font-mono text-[10.5px] text-muted">
                  {page}
                </figcaption>
              </figure>
            </div>
          );
        })}
        <div className="flex w-4 shrink-0 items-center justify-center" />
      </div>

      <div className="flex flex-col gap-1.5">
        {groups.map((group, index) => (
          <div
            key={group[0]}
            className="flex items-center gap-2 rounded-control border border-line bg-surface px-2.5 py-1.5 text-[12px]"
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-raised font-mono text-[10.5px] text-muted">
              {index + 1}
            </span>
            <span className="text-ink">
              {group.length === 1
                ? tf('split.onePage', { n: group[0]! })
                : tf('split.groupPages', { from: group[0]!, to: group[group.length - 1]! })}
            </span>
            <span className="text-faint">
              {tf('organizer.pages', { count: group.length })} · {group[0]!}-{group[group.length - 1]!}.pdf
            </span>
          </div>
        ))}
      </div>
      <p className="text-[11.5px] leading-5 text-faint">{t('split.hint')}</p>
    </div>
  );
}

function rangeEvery(pageCount: number, every: number): number[] {
  const cuts: number[] = [];
  for (let page = every; page < pageCount; page += every) cuts.push(page);
  return cuts;
}
