import { Icon } from '@potools/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useParams, Link } from 'react-router-dom';
import type { JobSnapshot, ToolDescriptor, ToolId } from 'core';
import { TOOLS } from 'core';
import { Button, Section, Badge, Card, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@potools/ui';
import { DropZone } from '../components/DropZone.tsx';
import { FileList } from '../components/FileList.tsx';
import { areOptionsValid, OptionForm } from '../components/OptionForm.tsx';
import { ResultPanel, TextRunPanel } from '../components/ResultPanel.tsx';
import { PageGrid, slotsFromProbes, type Slot } from './PageGrid.tsx';
import { SplitCanvas, groupsFromCuts } from './SplitCanvas.tsx';
import { useI18n } from '../i18n/index.tsx';
import { useToolDraft } from '../lib/useToolDraft.ts';
import { useEngine, rpcErrorMessage } from '../stores/engine.ts';
import { useJobs } from '../stores/jobs.ts';
import { useSettings } from '../lib/settings.ts';
import { formatBytes } from '../lib/format.ts';
import { kindFor } from '../lib/files.ts';
import { usePageThumbs } from '../lib/usePageThumbs.ts';
import { ImageStudioEditor } from '../components/ImageStudioEditor.tsx';
import type { PickedFile } from '../lib/files.ts';
import type { ProbedPdf } from 'core';
import { InvoiceOrganizerPage } from './InvoiceOrganizerPage.tsx';
import { ToolWorkspaceLayout } from '../components/PageLayout.tsx';

export function ToolPage() {
  const { toolId } = useParams<{ toolId: string }>();
  const descriptor = toolId ? TOOLS[toolId as ToolId] : undefined;
  if (!descriptor) return <Navigate to="/" replace />;
  if (descriptor.id === 'invoice-organize') return <InvoiceOrganizerPage />;
  return <ToolWorkspace key={descriptor.id} descriptor={descriptor} />;
}

function ToolWorkspace({ descriptor }: { descriptor: ToolDescriptor }) {
  const { t, tf } = useI18n();
  const draft = useToolDraft(descriptor);
  const status = useEngine((state) => state.status);
  const info = useEngine((state) => state.info);
  const reconnect = useEngine((state) => state.reconnect);
  const jobs = useJobs((state) => state.jobs);
  const settings = useSettings();
  const [slots, setSlots] = useState<Slot[]>([]);
  const imageStudio = descriptor.id === 'image-cutout' || descriptor.id === 'image-id-photo' || descriptor.id === 'image-watermark-clean';
  const [preparedPortrait, setPreparedPortrait] = useState<File | null>(null);
  const [preparedOverrides, setPreparedOverrides] = useState<Record<string, string | number | boolean>>({});
  const setPortrait = useCallback((file: File | null, overrides?: Record<string, string | number | boolean>) => { setPreparedPortrait(file); setPreparedOverrides(overrides ?? {}); }, []);

  const organizer = descriptor.layout === 'organizer';
  const splitter = descriptor.layout === 'splitter';
  const needsFiles = descriptor.requiresInput !== false;
  const [cuts, setCuts] = useState<number[]>([]);
  const total = useMemo(
    () => Object.values(draft.probes).reduce((sum, probe) => sum + probe.pageCount, 0),
    [draft.probes],
  );

  useEffect(() => {
    if (!organizer) return;
    setSlots((prev) => {
      const known = new Set(draft.files.map((file) => file.id));
      const kept = prev.filter((slot) => known.has(slot.fileId));
      const present = new Set(kept.map((slot) => slot.fileId));
      const added = slotsFromProbes(draft.files, draft.probes).filter((slot) => !present.has(slot.fileId));
      return [...kept, ...added];
    });
  }, [draft.files, draft.probes, organizer]);

  const job: JobSnapshot | undefined =
    jobs.find((item) => item.id === draft.jobId) ?? jobs.find((item) => item.tool === descriptor.id);

  const splitPreview = useMemo(() => {
    if (descriptor.layout !== 'splitter' || !total) return null;
    const mode = String(draft.options.mode ?? '');
    if (mode === 'each-page') return total;
    if (mode === 'every-n') return Math.ceil(total / Math.max(1, Number(draft.options.everyN) || 1));
    if (mode === 'halves') return 2;
    const ranges = String(draft.options.ranges ?? '')
      .split(/[,;，、]+/)
      .filter((part) => part.trim()).length;
    return draft.options.rangesAsOne ? 1 : Math.max(1, ranges);
  }, [descriptor.layout, draft.options, total]);

  const optionsValid = areOptionsValid(descriptor.fields, draft.options);
  const canRun = !draft.running && (!needsFiles || draft.files.length > 0) && status === 'ready' && optionsValid && (!organizer || slots.length > 0) && (!imageStudio || preparedPortrait !== null);
  const runDisabledReason = draft.running
    ? null
    : status !== 'ready'
      ? t('run.disabled.engine')
      : needsFiles && draft.files.length === 0
        ? t('run.needsFiles')
        : !optionsValid
          ? t('run.disabled.options')
          : organizer && slots.length === 0
            ? t('run.disabled.organizer')
            : imageStudio && !preparedPortrait
              ? t('run.disabled.image')
              : null;

  const onRun = async () => {
    if (organizer) {
      await draft.run({
        plan: slots.map((slot) => ({ fileId: slot.fileId, page: slot.page, rotation: slot.rotation })) as never,
      });
      return;
    }
    if (splitter && draft.options.mode === 'manual') {
      const first = draft.files[0];
      const pageCount = first ? (draft.probes[first.id]?.pageCount ?? 0) : 0;
      await draft.run({ groups: groupsFromCuts(cuts, pageCount) as never });
      return;
    }
    if (imageStudio) {
      if (preparedPortrait) await draft.runPrepared(preparedPortrait, preparedOverrides);
      return;
    }
    await draft.run();
  };

  const error = draft.error ? describeError(draft.error, t) : null;
  const textLayout = descriptor.layout === 'text';
  const outputDir = settings.outputDir ?? info?.defaultOutputDir ?? '';

  const header = (
    <div className="flex min-w-0 items-start gap-3">
      <Button asChild variant="outline" size="icon" className="mt-0.5">
        <Link
          to="/"
          title={t('nav.tools')}
          aria-label={t('nav.tools')}
        >
          <Icon name="chevronRight" size={15} className="rotate-180" />
        </Link>
      </Button>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[16px] font-semibold tracking-tight">{t(descriptor.nameKey)}</h2>
          <Badge variant="outline">{t(`workflow.${descriptor.workflow}`)}</Badge>
          {descriptor.multiFile ? <Badge variant="outline">{t('run.multiHint')}</Badge> : null}
        </div>
        <p className="mt-0.5 text-[12.5px] leading-5 text-muted">{t(descriptor.descKey)}</p>
      </div>
    </div>
  );

  const engineNotice = status !== 'ready' ? (
    <Card className="flex flex-wrap items-center gap-3 border-bad/40 bg-bad/5 px-4 py-3">
      <Icon name="warning" size={16} className="text-bad" />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-ink">{t('engine.offline')}</p>
        <p className="text-[11.5px] leading-5 text-muted">{t('engine.offlineHint')}</p>
      </div>
      <Button variant="ghost" icon="refresh" onClick={() => void reconnect()}>
        {t('settings.reconnect')}
      </Button>
    </Card>
  ) : null;

  const optionsSection = (
    <Section
      title={t('tool.options')}
      className="tool-options-section"
      aside={
        <Button
          variant="secondary"
          size="sm"
          className="h-8 shrink-0 px-3 text-[11.5px]"
          onClick={draft.resetOptions}
        >
          {t('common.reset')}
        </Button>
      }
    >
      <OptionForm fields={descriptor.fields} values={draft.options} onChange={draft.setOption} />
      {splitPreview ? (
        <p className="mt-3 rounded-control bg-raised px-2.5 py-2 text-[11.5px] text-muted">
          {tf('result.artifacts', { count: splitPreview })}
          {total ? ` · ${tf('organizer.pages', { count: total })}` : ''}
        </p>
      ) : null}
    </Section>
  );

  const runPanel = (
    <div className="flex flex-col gap-2">
      {error && !textLayout ? (
        <p className="flex items-start gap-1.5 rounded-control bg-bad/10 px-2.5 py-2 text-[12px] leading-5 text-ink">
          <Icon name="warning" size={13} className="mt-[3px] shrink-0 text-bad" />
          {error}
        </p>
      ) : null}
      <Button
        variant="primary"
        size="lg"
        icon="play"
        busy={draft.running}
        disabled={!canRun}
        className="w-full"
        onClick={() => void onRun()}
        aria-describedby={runDisabledReason ? 'run-disabled-reason' : undefined}
      >
        {draft.running ? t('run.running') : t('run.button')}
      </Button>
      {runDisabledReason ? (
        <p id="run-disabled-reason" className="text-center text-[11px] leading-4 text-faint" role="status">
          {runDisabledReason}
        </p>
      ) : null}
      {imageStudio && !preparedPortrait ? <p className="text-center text-[11px] leading-4 text-faint">{t('imageStudio.needFile')}</p> : null}
      {textLayout ? (
        <p className="text-center text-[11px] leading-4 text-faint">{t('result.textOnlyHint')}</p>
      ) : (
        <p className="text-center text-[11px] leading-4 text-faint">
          {settings.outputDir ? (
            <>
              {t('result.outputDir')} ·{' '}
              <span className="font-mono" title={settings.outputDir}>
                {shorten(settings.outputDir)}
              </span>
            </>
          ) : (
            t('result.noDir')
          )}
        </p>
      )}
    </div>
  );

  const resultPanel = textLayout ? (
    <TextRunPanel
      defaultName={`${descriptor.id}.txt`}
      result={draft.textResult}
      error={error}
      errorCode={draft.errorCode}
      running={draft.running}
      onRetry={() => void onRun()}
    />
  ) : (
    <ResultPanel job={job} onRetry={() => void onRun()} />
  );

  if (textLayout) {
    return (
      <ToolWorkspaceLayout header={header} width="text">
        {engineNotice}
        {optionsSection}
        {runPanel}
        {resultPanel}
      </ToolWorkspaceLayout>
    );
  }

  return (
    <ToolWorkspaceLayout header={header}>
      {engineNotice}

      <div className="tool-workspace-grid items-start gap-4">
        <div className="flex min-w-0 flex-col gap-4">
          {needsFiles ? (
            <Section
              title={t('tool.inputFiles')}
              className="tool-input-section"
              aside={
                draft.files.length ? (
                  <span className="flex shrink-0 items-center gap-2 text-[11.5px] text-faint">
                    {tf('file.count', { count: draft.files.length })}
                    {total ? ` · ${tf('organizer.pages', { count: total })}` : ''}
                    <Button variant="link" size="sm" className="h-auto p-0 text-[11.5px]" onClick={draft.clear}>
                      {t('common.reset')}
                    </Button>
                  </span>
                ) : null
              }
            >
              <div className="flex flex-col gap-3">
                <DropZone
                  accept={kindFor(descriptor.accept)}
                  multiple={descriptor.multiFile}
                  compact={draft.files.length > 0}
                  busy={draft.probing}
                  onFiles={(files) => draft.addFiles(files)}
                />
                {draft.files.length ? (
                  <FileList
                    files={draft.files}
                    probes={draft.probes}
                    probing={draft.probing}
                    orderSensitive={descriptor.orderSensitive}
                    onReorder={draft.reorder}
                    onRemove={draft.removeFile}
                  />
                ) : null}
              </div>
            </Section>
          ) : null}

          {imageStudio ? (
            <Section title={t('imageStudio.preview')}>
              <ImageStudioEditor
                tool={descriptor.id as 'image-cutout' | 'image-id-photo' | 'image-watermark-clean'}
                source={draft.files[0]}
                options={draft.options}
                onReady={setPortrait}
              />
            </Section>
          ) : null}

          {draft.files.length && !imageStudio && (descriptor.accept.startsWith('application/pdf') || descriptor.accept.startsWith('image/')) ? (
            <InputPreview files={draft.files} probes={draft.probes} title={t('preview.input')} />
          ) : null}

          {organizer ? (
            <Section title={t('organizer.title')}>
              <PageGrid files={draft.files} probes={draft.probes} slots={slots} onChange={setSlots} />
            </Section>
          ) : null}

          {splitter && draft.options.mode === 'manual' && draft.files[0] ? (
            <Section title={t('split.visual')} aside={<span className="shrink-0 text-[11.5px] text-faint">{draft.files[0].name}</span>}>
              <SplitCanvas
                file={draft.files[0]}
                probe={draft.probes[draft.files[0].id]}
                cuts={cuts}
                onChange={setCuts}
              />
            </Section>
          ) : null}

          {descriptor.layout === 'metadata' && draft.files.length ? (
            <MetadataInspector
              files={draft.files.map((file) => ({ name: file.name, probe: draft.probes[file.id] }))}
              onApply={(values) => draft.setOptions({ ...draft.options, mode: 'write', ...values })}
              copyLabel={t('metadata.fill')}
            />
          ) : null}

          {resultPanel}
        </div>

        <div className="tool-run-column flex flex-col gap-3">
          {optionsSection}
          {runPanel}
        </div>
      </div>
    </ToolWorkspaceLayout>
  );
}

function InputPreview({
  files,
  probes,
  title,
}: {
  files: PickedFile[];
  probes: Record<string, ProbedPdf>;
  title: string;
}) {
  const { t } = useI18n();
  const [active, setActive] = useState<{ fileId: string; page: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragOrigin = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const wanted = useMemo(() => {
    const items: Array<{ fileId: string; page: number }> = [];
    for (const file of files) {
      const pages = probes[file.id]?.pageCount ?? 1;
      const previewPages = Math.min(pages, file === files[0] ? 6 : 2);
      for (let page = 1; page <= previewPages && items.length < 12; page += 1) {
        items.push({ fileId: file.id, page });
      }
      if (items.length >= 12) break;
    }
    return items;
  }, [files, probes]);
  // Keep card previews quick to rasterize and transfer. The separate modal
  // request uses a high-resolution PNG only after the user opens a page.
  const { thumbs } = usePageThumbs(files, wanted, 192);
  const largeWanted = useMemo(() => active ? [active] : [], [active]);
  const { thumbs: largeThumbs } = usePageThumbs(files, largeWanted, 2200);

  return (
    <Section title={title}>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
        {wanted.map((item) => {
          const thumb = thumbs[`${item.fileId}:${item.page}:192`];
          const file = files.find((entry) => entry.id === item.fileId);
          return (
            <figure key={`${item.fileId}:${item.page}`} className="min-w-0 overflow-hidden rounded-control border border-line bg-canvas">
              <button
                type="button"
                aria-label={tfPreviewLabel(t('preview.open'), file?.name ?? '', item.page)}
                onClick={() => { setZoom(1); setRotation(0); setPan({ x: 0, y: 0 }); setActive(item); }}
                className="group block w-full cursor-zoom-in text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
              >
              <div className="flex h-[148px] items-center justify-center p-2">
                {thumb ? <img src={thumb.dataUrl} alt="" className="max-h-full max-w-full object-contain shadow-card transition-transform group-hover:scale-[1.02]" /> : <span className="text-[11px] text-faint">{t('preview.loading')}</span>}
              </div>
              <figcaption className="truncate border-t border-line px-2 py-1.5 text-[10.5px] text-muted" title={file?.name}>
                {file?.name}{probes[item.fileId] ? ` · ${item.page}` : ''}
              </figcaption>
              </button>
            </figure>
          );
        })}
      </div>
      {wanted.length === 0 ? <p className="text-[11.5px] text-faint">{t('preview.unavailable')}</p> : null}
      <Dialog open={active !== null} onOpenChange={(open) => { if (!open) setActive(null); }}>
        <DialogContent className="flex h-[min(92vh,58rem)] w-[min(96vw,84rem)] max-w-none flex-col overflow-hidden p-0" aria-describedby="page-preview-description">
          <DialogHeader className="shrink-0 border-b border-line px-5 py-3 pr-12">
            <DialogTitle className="truncate text-[14px]">{t('preview.large')}</DialogTitle>
            <DialogDescription id="page-preview-description" className="truncate">
              {active ? `${files.find((file) => file.id === active.fileId)?.name ?? ''} · ${tfPreviewPage(t('preview.page'), active.page)}` : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-3 py-2">
            <div className="flex items-center gap-1">
              <Button variant="outline" size="icon-sm" aria-label={t('preview.zoomOut')} title={t('preview.zoomOut')} disabled={zoom <= 0.25} onClick={() => setZoom((value) => Math.max(0.25, Math.round((value - 0.25) * 100) / 100))}><Icon name="minus" size={14} /></Button>
              <span className="w-12 text-center text-[11px] tabular-nums text-muted">{Math.round(zoom * 100)}%</span>
              <Button variant="outline" size="icon-sm" aria-label={t('preview.zoomIn')} title={t('preview.zoomIn')} disabled={zoom >= 4} onClick={() => setZoom((value) => Math.min(4, Math.round((value + 0.25) * 100) / 100))}><Icon name="plus" size={14} /></Button>
              <Button variant="outline" size="sm" className="ml-1" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}>{t('preview.fit')}</Button>
              <Button variant="outline" size="icon-sm" aria-label={t('preview.rotateLeft')} title={t('preview.rotateLeft')} onClick={() => setRotation((value) => value - 90)}><Icon name="reset" size={14} /></Button>
              <Button variant="outline" size="icon-sm" aria-label={t('preview.rotateRight')} title={t('preview.rotateRight')} onClick={() => setRotation((value) => value + 90)}><Icon name="rotate-cw" size={14} /></Button>
              <Button variant="outline" size="icon-sm" aria-label={t('preview.reset')} title={t('preview.reset')} onClick={() => { setZoom(1); setRotation(0); setPan({ x: 0, y: 0 }); }}><Icon name="maximize2" size={14} /></Button>
            </div>
            <span className="hidden text-[11px] text-faint sm:inline">{t('preview.zoomHint')}</span>
          </div>
          <div
            className={`flex min-h-0 flex-1 items-center justify-center overflow-auto bg-canvas p-4 sm:p-8 ${zoom > 1 ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : ''}`}
            onWheel={(event) => {
              if (!event.ctrlKey && !event.metaKey) return;
              event.preventDefault();
              setZoom((value) => Math.min(4, Math.max(0.25, Math.round((value * (event.deltaY < 0 ? 1.1 : 0.9)) * 100) / 100)));
            }}
            onPointerDown={(event) => {
              if (zoom <= 1 || event.button !== 0) return;
              dragOrigin.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
              event.currentTarget.setPointerCapture(event.pointerId);
              setDragging(true);
            }}
            onPointerMove={(event) => {
              const origin = dragOrigin.current;
              if (!origin) return;
              setPan({ x: origin.panX + event.clientX - origin.x, y: origin.panY + event.clientY - origin.y });
            }}
            onPointerUp={() => { dragOrigin.current = null; setDragging(false); }}
            onPointerCancel={() => { dragOrigin.current = null; setDragging(false); }}
          >
            {active && largeThumbs[`${active.fileId}:${active.page}:2200`] ? (
              <img
                src={largeThumbs[`${active.fileId}:${active.page}:2200`]?.dataUrl}
                alt={`${files.find((file) => file.id === active.fileId)?.name ?? ''} · ${active.page}`}
                draggable={false}
                className="max-h-full max-w-full shrink-0 select-none object-contain shadow-pop"
                style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom}) rotate(${rotation}deg)`, transformOrigin: 'center' }}
              />
            ) : <span className="text-[12px] text-faint">{t('preview.loading')}</span>}
          </div>
          <DialogFooter className="m-0 shrink-0 justify-between border-t border-line px-4 py-3 sm:justify-between">
            <span className="text-[11px] text-faint">{t('preview.clickHint')}</span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={!active || !hasAdjacentPage(wanted, active, -1)} onClick={() => { setActive((current) => adjacentPage(wanted, current, -1)); setZoom(1); setRotation(0); setPan({ x: 0, y: 0 }); }}>{t('preview.previous')}</Button>
              <Button variant="outline" size="sm" disabled={!active || !hasAdjacentPage(wanted, active, 1)} onClick={() => { setActive((current) => adjacentPage(wanted, current, 1)); setZoom(1); setRotation(0); setPan({ x: 0, y: 0 }); }}>{t('preview.next')}</Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Section>
  );
}

function adjacentPage(
  items: Array<{ fileId: string; page: number }>,
  current: { fileId: string; page: number } | null,
  delta: number,
) {
  if (!current) return current;
  const index = items.findIndex((item) => item.fileId === current.fileId && item.page === current.page);
  return items[index + delta] ?? current;
}

function hasAdjacentPage(items: Array<{ fileId: string; page: number }>, current: { fileId: string; page: number }, delta: number) {
  const index = items.findIndex((item) => item.fileId === current.fileId && item.page === current.page);
  return index + delta >= 0 && index + delta < items.length;
}

function tfPreviewPage(template: string, page: number) {
  return template.replace('{page}', String(page));
}

function tfPreviewLabel(template: string, name: string, page: number) {
  return template.replace('{name}', name).replace('{page}', String(page));
}

function shorten(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path;
}

function describeError(raw: string, t: (key: string) => string): string {
  const known = ['error.encrypted', 'error.unreadable', 'error.noFont', 'error.noRasterizer', 'error.noImageCodec'];
  if (known.includes(raw)) return t(raw);
  return raw;
}

const META_ROWS = ['title', 'author', 'subject', 'keywords', 'creator', 'producer'] as const;

function MetadataInspector({
  files,
  onApply,
  copyLabel,
}: {
  files: { name: string; probe?: { metadata: Record<string, string>; pageCount: number; sizeBytes: number } }[];
  onApply: (values: Record<string, string>) => void;
  copyLabel: string;
}) {
  const { t } = useI18n();
  const first = files.find((entry) => entry.probe)?.probe;
  if (!first) {
    return (
      <Section title={t('tool.metadata.name')}>
        <p className="text-[12px] text-faint">{t('file.reading')}</p>
      </Section>
    );
  }
  return (
    <Section
      title={t('tool.metadata.name')}
      aside={
        <Button
          type="button"
          onClick={() => {
            const values: Record<string, string> = {};
            for (const row of META_ROWS) values[row] = first.metadata[row] ?? '';
            onApply(values);
          }}
          variant="link"
          size="sm"
          className="h-7 shrink-0 px-1 text-[11.5px]"
        >
          {copyLabel}
        </Button>
      }
    >
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
        {META_ROWS.map((row) => (
          <div key={row} className="flex min-w-0 items-baseline gap-2 border-b border-line/70 py-1 last:border-0">
            <dt className="w-[68px] shrink-0 text-[11.5px] text-faint">{t(`opt.metadata.${row}`)}</dt>
            <dd className="min-w-0 flex-1 truncate text-[12.5px] text-ink" title={first.metadata[row]}>
              {first.metadata[row] || '—'}
            </dd>
          </div>
        ))}
        <div className="flex min-w-0 items-baseline gap-2 py-1">
          <dt className="w-[68px] shrink-0 text-[11.5px] text-faint">{t('organizer.pageCount')}</dt>
          <dd className="text-[12.5px] text-ink">{first.pageCount}</dd>
        </div>
        <div className="flex min-w-0 items-baseline gap-2 py-1">
          <dt className="w-[68px] shrink-0 text-[11.5px] text-faint">{t('result.title')}</dt>
          <dd className="text-[12.5px] text-ink">{formatBytes(first.sizeBytes)}</dd>
        </div>
      </dl>
    </Section>
  );
}
