import { useState } from 'react';
import type { ProbedPdf } from 'core';
import { Icon } from '@potools/ui';
import { IconButton } from '@potools/ui';
import { useI18n } from '../i18n/index.tsx';
import { formatBytes } from '../lib/format.ts';
import type { PickedFile } from '../lib/files.ts';

export function FileList({
  files,
  probes,
  probing,
  orderSensitive,
  onReorder,
  onRemove,
}: {
  files: PickedFile[];
  probes: Record<string, ProbedPdf>;
  /** Tools that never probe (Office/OFD/Markdown inputs) have no metadata to await. */
  probing?: boolean;
  orderSensitive?: boolean;
  onReorder: (from: number, to: number) => void;
  onRemove: (id: string) => void;
}) {
  const { t, tf } = useI18n();
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  return (
    <ul className="flex flex-col gap-1.5">
      {files.map((file, index) => {
        const probe = probes[file.id];
        return (
          <li
            key={file.id}
            draggable={orderSensitive}
            onDragStart={() => setDragIndex(index)}
            onDragOver={(event) => {
              if (dragIndex === null) return;
              event.preventDefault();
              setOverIndex(index);
            }}
            onDrop={() => {
              if (dragIndex !== null && overIndex !== null && dragIndex !== overIndex) {
                onReorder(dragIndex, overIndex);
              }
              setDragIndex(null);
              setOverIndex(null);
            }}
            onDragEnd={() => {
              setDragIndex(null);
              setOverIndex(null);
            }}
            className={`group flex items-center gap-2.5 rounded-control border bg-surface px-2.5 py-2 transition ${
              overIndex === index && dragIndex !== null ? 'border-accent' : 'border-line'
            } ${dragIndex === index ? 'opacity-60' : ''}`}
          >
            {orderSensitive ? (
              <span className="cursor-grab text-faint active:cursor-grabbing" title={t('file.orderHint')}>
                <Icon name="layers" size={14} />
              </span>
            ) : (
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-raised text-[10.5px] font-semibold text-muted">
                {index + 1}
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] leading-5 text-ink" title={file.path ?? file.name}>
                {file.name}
              </span>
              <span className="flex items-center gap-1.5 text-[11.5px] leading-4 text-faint">
                {file.size ? <span>{formatBytes(file.size)}</span> : null}
                {probe ? (
                  <span>
                    {tf('file.pages', { count: probe.pageCount })}
                    {probe.uniformSize ? null : ` · ${t('file.mixedSizes')}`}
                  </span>
                ) : probing ? (
                  <span>{t('file.reading')}</span>
                ) : null}
              </span>
            </span>
            {orderSensitive ? (
              <span className="flex shrink-0 items-center opacity-0 transition group-hover:opacity-100">
                <IconButton
                  icon="up"
                  size={13}
                  label={t('file.up')}
                  disabled={index === 0}
                  onClick={() => onReorder(index, index - 1)}
                />
                <IconButton
                  icon="down"
                  size={13}
                  label={t('file.down')}
                  disabled={index === files.length - 1}
                  onClick={() => onReorder(index, index + 1)}
                />
              </span>
            ) : null}
            <IconButton
              icon="close"
              size={13}
              label={t('file.remove')}
              onClick={() => onRemove(file.id)}
              className="shrink-0 opacity-0 transition group-hover:opacity-100"
            />
          </li>
        );
      })}
    </ul>
  );
}
