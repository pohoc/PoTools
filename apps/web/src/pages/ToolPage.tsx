import { Icon } from '@potools/ui';
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, useParams, Link } from 'react-router-dom';
import type { JobSnapshot, ToolDescriptor, ToolId } from 'core';
import { TOOLS } from '../lib/core-bindings.ts';
import { browserRunBlocker } from '../lib/browser-limits.ts';
import { Button, Section, Badge, Card, toast } from '@potools/ui';
import { DropZone } from '../components/DropZone.tsx';
import { ColorPickerPanel } from '../components/ColorPickerPanel.tsx';
import { PasswordStrengthPanel } from '../components/PasswordStrengthPanel.tsx';
import { FileList } from '../components/FileList.tsx';
import { areOptionsValid, OptionForm } from '../components/OptionForm.tsx';
import { PageGrid, slotsFromProbes, type Slot } from './PageGrid.tsx';
import { SplitCanvas, groupsFromCuts } from './SplitCanvas.tsx';
import { useI18n } from '../i18n/index.tsx';
import { useToolDraft } from '../lib/useToolDraft.ts';
import { useEngine } from '../stores/engine.ts';
import { useJobs } from '../stores/jobs.ts';
import { useSettings } from '../lib/settings.ts';
import { formatBytes } from '../lib/format.ts';
import { localizedErrorText } from '../lib/error-text.ts';
import { filesFromDataTransfer, kindFor } from '../lib/files.ts';
import { ToolWorkspaceLayout } from '../components/PageLayout.tsx';

// Result preview and the image studio are the two heaviest parts of the page:
// the former pulls in @open-file-viewer (mermaid/cytoscape/katex/pptx-renderer/
// heic2any) plus pdf.js, the latter mediapipe. Neither is needed to render the
// form, so both are split out and fetched only when the relevant tool actually
// shows them.
const ResultPanel = lazy(() =>
  import('../components/ResultPanel.tsx').then((module) => ({ default: module.ResultPanel })),
);
const TextRunPanel = lazy(() =>
  import('../components/ResultPanel.tsx').then((module) => ({ default: module.TextRunPanel })),
);
const ImageStudioEditor = lazy(() =>
  import('../components/ImageStudioEditor.tsx').then((module) => ({ default: module.ImageStudioEditor })),
);
const InvoiceOrganizerPage = lazy(() =>
  import('./InvoiceOrganizerPage.tsx').then((module) => ({ default: module.InvoiceOrganizerPage })),
);

export function ToolPage() {
  const { toolId } = useParams<{ toolId: string }>();
  const descriptor = toolId ? TOOLS[toolId as ToolId] : undefined;
  if (!descriptor) return <Navigate to="/" replace />;
  return (
    <Suspense fallback={null}>
      {descriptor.id === 'invoice-organize' ? (
        <InvoiceOrganizerPage />
      ) : (
        <ToolWorkspace key={descriptor.id} descriptor={descriptor} />
      )}
    </Suspense>
  );
}

function ToolWorkspace({ descriptor }: { descriptor: ToolDescriptor }) {
  const { t, tf } = useI18n();
  const draft = useToolDraft(descriptor);
  // Destructured so the paste effect can depend on the callback instead of the
  // whole draft object (`useToolDraft` keeps its identity stable).
  const { addFiles } = draft;
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

  useEffect(() => {
    if (!needsFiles) return;
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select, [contenteditable="true"]'))) return;
      const transfer = event.clipboardData;
      if (!transfer) return;
      const accepted = descriptor.accept.split(',').map((part) => part.trim().toLowerCase()).filter(Boolean);
      const files = filesFromDataTransfer(transfer).filter((picked) => {
        const file = picked.file;
        if (!file) return false;
        const type = file.type.toLowerCase();
        const name = file.name.toLowerCase();
        return accepted.some((rule) => rule === '*/*' || (rule.endsWith('/*') && type.startsWith(rule.slice(0, -1))) || (rule.startsWith('.') && name.endsWith(rule)) || (rule === type));
      });
      if (!files.length) return;
      event.preventDefault();
      addFiles(files);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
    // `addFiles` is destructured so the dependency is the callback itself rather
    // than the whole draft object; `useToolDraft` keeps its identity stable.
  }, [descriptor.accept, addFiles, needsFiles]);
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
  const browserBlocker = useMemo(() => browserRunBlocker(descriptor.id), [descriptor.id]);
  // 识别（probe）完成前不允许运行：页数、预览与部分工具的选项校验都依赖它。
  const canRun = !draft.running && !draft.probing && !browserBlocker && (!needsFiles || draft.files.length > 0) && status === 'ready' && optionsValid && (!organizer || slots.length > 0) && (!imageStudio || preparedPortrait !== null);
  const runDisabledReason = draft.running
    ? null
    : browserBlocker
      ? t(browserBlocker)
      : status !== 'ready'
      ? t('run.disabled.engine')
      : needsFiles && draft.files.length === 0
        ? t('run.needsFiles')
        : draft.probing
          ? t('run.disabled.probing')
          : !optionsValid
            ? t('run.disabled.options')
            : organizer && slots.length === 0
              ? t('run.disabled.organizer')
              : imageStudio && !preparedPortrait
                ? t('run.disabled.image')
                : null;

  const onRun = async () => {
    // Every "no-op" path (stale result panel after HMR, browser limits,
    // missing files) must give visible feedback instead of failing silently.
    if (draft.running) return;
    if (!canRun) {
      toast.error(runDisabledReason ?? t('run.needsFiles'));
      return;
    }
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

  const error = draft.error ? describeError(draft.error, draft.errorCode, t) : null;
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
          {descriptor.networkAccess ? (
            <Badge variant="outline" className="gap-1 border-warn/40 bg-warn/10 text-warn">
              <Icon name="globe" size={12} />{t(`network.access.${descriptor.networkAccess}`)}
            </Badge>
          ) : null}
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
  const networkNotice = descriptor.networkAccess ? (
    <Card className="flex flex-row items-center gap-2.5 border-warn/35 bg-warn/5 px-3.5 py-3">
      <Icon name="globe" size={15} className="shrink-0 text-warn" />
      <p className="min-w-0 text-[11.5px] leading-5 text-muted">{t(`network.notice.${descriptor.networkAccess}`)}</p>
    </Card>
  ) : null;

  // Tools without options (format-only converters) would show an empty card.
  const optionsSection = descriptor.fields.length ? (
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
  ) : null;

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
          {outputDir ? (
            <>
              {t('result.outputDir')} ·{' '}
              <span className="font-mono" title={outputDir}>
                {shorten(outputDir)}
              </span>
              {settings.outputDir ? null : <span className="text-faint"> · {t('settings.defaultDir')}</span>}
            </>
          ) : (
            t('result.noDir')
          )}
        </p>
      )}
    </div>
  );

  const resultPanel = (
    <Suspense fallback={null}>
      {textLayout ? (
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
      )}
    </Suspense>
  );

  if (descriptor.id === 'color-convert') {
    return (
      <ToolWorkspaceLayout header={header} width="text">
        <ColorPickerPanel />
      </ToolWorkspaceLayout>
    );
  }

  if (descriptor.id === 'password-strength') {
    return (
      <ToolWorkspaceLayout header={header} width="text">
        <PasswordStrengthPanel />
      </ToolWorkspaceLayout>
    );
  }

  if (textLayout) {
    return (
      <ToolWorkspaceLayout header={header} width="text">
        {engineNotice}
        {networkNotice}
        {optionsSection}
        {runPanel}
        {resultPanel}
      </ToolWorkspaceLayout>
    );
  }

  return (
    <ToolWorkspaceLayout header={header}>
      {engineNotice}
      {networkNotice}

      <div className="tool-workspace-grid items-start gap-4">
        <div className="tool-workspace-input-column flex min-w-0 flex-col gap-4">
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
                  onFiles={addFiles}
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
              <Suspense fallback={null}>
                <ImageStudioEditor
                  tool={descriptor.id as 'image-cutout' | 'image-id-photo' | 'image-watermark-clean'}
                  source={draft.files[0]}
                  options={draft.options}
                  onReady={setPortrait}
                />
              </Suspense>
            </Section>
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

          <div className="tool-result-panel">{resultPanel}</div>
        </div>

        <div className="tool-run-column flex flex-col gap-3">
          {optionsSection}
          <div className="tool-run-panel">{runPanel}</div>
        </div>
      </div>
    </ToolWorkspaceLayout>
  );
}

function shorten(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path;
}

function describeError(raw: string, code: string | null, t: (key: string) => string): string {
  // The draft stores either an i18n key (when the engine supplied a hintKey) or
  // a raw message, so `raw` is tried as both before falling back to the code.
  return localizedErrorText({ message: raw, code: code ?? undefined, hintKey: raw }, t);
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
