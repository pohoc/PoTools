import { useEffect, useState } from 'react';
import type { JobSnapshot, OutputFile } from 'core';
import { TOOLS } from 'core';
import type { FileRef, PageThumb } from 'core';
import { Icon } from './Icon.tsx';
import { Button, EmptyState, ProgressBar, Section, StateBadge } from './ui.tsx';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog.tsx';
import { useI18n } from '../i18n/index.tsx';
import { formatBytes, formatDuration } from '../lib/format.ts';
import {
  chooseSaveDir,
  downloadArtifact,
  openArtifact,
  revealArtifact,
  saveArtifactToFolder,
  saveAllToFolder,
} from '../lib/files.ts';
import { isTauri } from '../lib/tauri.ts';
import { rpcErrorMessage } from '../stores/engine.ts';
import { useSettings } from '../lib/settings.ts';
import { useEngine } from '../stores/engine.ts';
import { toast } from 'sonner';

const KIND_ICON: Record<string, string> = {
  image: 'images',
  json: 'file',
  pdf: 'file-text',
  docx: 'word',
  doc: 'word',
  xlsx: 'excel',
  xls: 'excel',
  pptx: 'ppt',
  ppt: 'ppt',
  md: 'markdown',
  html: 'globe',
  csv: 'table',
  rtf: 'file-text',
  epub: 'book',
  ofd: 'scan',
  text: 'file-text',
};

function kindIcon(artifact: OutputFile): string {
  return KIND_ICON[artifact.kind] ?? 'file';
}

export function ResultPanel({ job, onRetry }: { job?: JobSnapshot; onRetry?: () => void }) {
  const { t, tf } = useI18n();
  const settings = useSettings();
  const call = useEngine((state) => state.call);

  if (!job) {
    return (
      <Section title={t('result.title')}>
        <EmptyState icon="file" title={t('result.empty')} hint={t('result.noDir')} />
      </Section>
    );
  }

  const running = job.progress.state === 'running' || job.progress.state === 'queued';
  const error = job.error ? rpcErrorMessage(job.error) : null;
  const summary = job.summary;
  const delta = summary?.sizeDeltaPercent ?? 0;
  const descriptor = TOOLS[job.tool];
  // A byte-for-byte comparison is only meaningful when both sides are PDFs.
  const sameFormat = descriptor
    ? descriptor.accept.startsWith('application/pdf') === (descriptor.artifactKind === 'pdf')
    : false;

  const saveAll = async () => {
    try {
      const count = await saveAllToFolder(job.id, job.artifacts);
      if (count) toast.success(tf('result.savedCount', { count }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('result.saveFailed'));
    }
  };

  const saveOne = async (artifact: OutputFile) => {
    const dir = await chooseSaveDir();
    if (!dir) {
      await downloadArtifact(artifact);
      return;
    }
    try {
      const path = await saveArtifactToFolder(job.id, artifact, dir);
      if (path) toast.success(tf('result.savedTo', { path }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('result.saveFailed'));
    }
  };

  const printOne = async (artifact: OutputFile) => {
    if (!artifact.path) return;
    try {
      await call('shell.print', { path: artifact.path });
      toast.success(t('result.printStarted'));
    } catch (issue) {
      toast.error(issue instanceof Error ? issue.message : t('result.printFailed'));
    }
  };

  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          {t('result.title')}
          <StateBadge state={job.progress.state} />
        </span>
      }
      aside={
        <span className="flex shrink-0 items-center gap-2">
          {job.artifacts.length ? (
            <Button
              size="sm"
              variant="ghost"
              icon="save"
              onClick={() => void saveAll()}
            >
              {t('result.saveAllTo')}
            </Button>
          ) : null}
          {job.finishedAt ? (
            <span className="text-[11.5px] text-faint">{formatDuration(job.finishedAt - job.createdAt)}</span>
          ) : null}
        </span>
      }
      dense
    >
      {running ? (
        <div className="flex flex-col gap-2 px-4 py-4">
          <ProgressBar percent={job.progress.percent} state={job.progress.state} />
          <p className="text-[12px] text-muted">
            {job.progress.current !== undefined && job.progress.total
              ? `${job.progress.current} / ${job.progress.total}`
              : `${Math.round(job.progress.percent)}%`}
          </p>
        </div>
      ) : null}

      {error ? (
        <div className="mx-4 mb-4 flex items-start gap-2 rounded-control border border-bad/30 bg-bad/10 px-3 py-2.5">
          <Icon name="warning" size={15} className="mt-[1px] shrink-0 text-bad" />
          <div className="min-w-0">
            <p className="text-[12.5px] leading-5 text-ink">{error.hintKey ? t(error.hintKey) : error.message}</p>
            <p className="mt-0.5 font-mono text-[11px] text-faint">{error.code}</p>
          </div>
          {onRetry ? (
            <Button size="sm" variant="ghost" icon="reset" className="ml-auto shrink-0" onClick={onRetry}>
              {t('job.retry')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {job.warnings.length ? (
        <ul className="mx-4 mb-3 flex flex-col gap-1 rounded-control bg-warn/10 px-3 py-2.5">
          {job.warnings.map((warning, index) => (
            <li key={index} className="flex items-start gap-1.5 text-[12px] leading-5 text-ink">
              <Icon name="warning" size={13} className="mt-[3px] shrink-0 text-warn" />
              {warning}
            </li>
          ))}
        </ul>
      ) : null}

      {summary ? (
        <div className="mx-4 mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-control bg-raised px-3 py-2 text-[12px]">
          <span className="text-muted">
            {tf('result.summary', { in: formatBytes(summary.inputBytes), out: formatBytes(summary.outputBytes) })}
          </span>
          {/* Size delta only means something when input and output are the same kind. */}
          {delta !== 0 && sameFormat ? (
            <span className={delta < 0 ? 'font-medium text-ok' : 'font-medium text-warn'}>
              {delta < 0 ? tf('result.deltaDown', { percent: Math.abs(delta) }) : tf('result.deltaUp', { percent: delta })}
            </span>
          ) : null}
          <span className="text-muted">{tf('result.artifacts', { count: job.artifacts.length })}</span>
          {summary.pageCountIn ? (
            <span className="text-muted">{tf('result.pages', { in: summary.pageCountIn, out: summary.pageCountOut })}</span>
          ) : null}
        </div>
      ) : null}

      {job.artifacts.length ? (
        <ul className="flex flex-col gap-1 px-4 pb-4">
            {job.artifacts.map((artifact) => (
            <li
              key={artifact.id}
              className="group flex items-center gap-2.5 rounded-control border border-line bg-surface px-2.5 py-2"
            >
              {artifact.kind === 'image' ? <OutputImagePreview jobId={job.id} artifact={artifact} /> : null}
              <Icon name={kindIcon(artifact)} size={15} className="shrink-0 text-faint" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] leading-5 text-ink" title={artifact.path ?? artifact.name}>
                  {artifact.name}
                </span>
                <span className="block text-[11px] leading-4 text-faint">
                  {formatBytes(artifact.sizeBytes)}
                  {artifact.page ? ` · p${artifact.page}` : ''}
                  {artifact.path ? '' : ' · temp'}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1">
                {artifact.path ? (
                  <Button size="sm" variant="quiet" icon="printer" title={t('result.print')} onClick={() => void printOne(artifact)}>
                    {t('result.printShort')}
                  </Button>
                ) : null}
                {artifact.path ? (
                  <Button
                    size="sm"
                    variant="quiet"
                    icon="save"
                    title={t('result.saveTo')}
                    onClick={() => void saveOne(artifact)}
                  >
                    {t('result.saveToShort')}
                  </Button>
                ) : null}
                {artifact.path ? (
                  <Button size="sm" variant="quiet" icon="folder" onClick={() => void revealArtifact(artifact)}>
                    {t('result.revealShort')}
                  </Button>
                ) : (
                  <Button size="sm" variant="quiet" icon="download" onClick={() => void downloadArtifact(artifact)}>
                    {t('result.downloadShort')}
                  </Button>
                )}
                {isTauri() && artifact.path ? (
                  <Button size="sm" variant="quiet" icon="file" title={t('result.open')} onClick={() => void openArtifact(artifact)}>
                    {t('result.openShort')}
                  </Button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex items-center gap-2 border-t border-line px-4 py-2.5 text-[11.5px] text-faint">
        <Icon name="folder" size={13} />
        <span className="truncate" title={settings.outputDir ?? ''}>
          {settings.outputDir ?? t('result.noDir')}
        </span>
      </div>
    </Section>
  );
}

function OutputImagePreview({
  jobId,
  artifact,
}: {
  jobId: string;
  artifact: OutputFile;
}) {
  const call = useEngine((state) => state.call);
  const { t } = useI18n();
  const [thumb, setThumb] = useState<PageThumb | null>(null);
  const [large, setLarge] = useState<PageThumb | null>(null);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const file: FileRef = {
      id: `output-${jobId}-${artifact.id}`,
      name: artifact.name,
      path: artifact.path ?? undefined,
      sizeBytes: artifact.sizeBytes,
      dataBase64: artifact.path ? undefined : artifact.dataBase64,
    };
    if (!file.path && !file.dataBase64) {
      setFailed(true);
      return;
    }
    void call<PageThumb[]>('page.thumbs', { file, pages: [1], width: 160 })
      .then((result) => {
        if (alive) setThumb(result[0] ?? null);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => { alive = false; };
  }, [artifact.id, artifact.name, artifact.path, artifact.sizeBytes, artifact.dataBase64, call, jobId]);

  useEffect(() => {
    if (!open || large) return;
    const file: FileRef = {
      id: `output-${jobId}-${artifact.id}`,
      name: artifact.name,
      path: artifact.path ?? undefined,
      sizeBytes: artifact.sizeBytes,
      dataBase64: artifact.path ? undefined : artifact.dataBase64,
    };
    void call<PageThumb[]>('page.thumbs', { file, pages: [1], width: 1600 })
      .then((result) => setLarge(result[0] ?? null))
      .catch(() => setLarge(thumb));
  }, [open, large, thumb, artifact.id, artifact.name, artifact.path, artifact.sizeBytes, artifact.dataBase64, call, jobId]);

  if (failed || !thumb) return null;
  return (
    <>
      <button
        type="button"
        className="flex h-12 w-14 shrink-0 items-center justify-center overflow-hidden rounded-control border border-line bg-canvas"
        aria-label={t('preview.large')}
        title={t('preview.large')}
        onClick={() => setOpen(true)}
      >
        <img src={thumb.dataUrl} alt="" className="max-h-full max-w-full object-contain" />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex h-[min(92vh,58rem)] w-[min(96vw,84rem)] max-w-none flex-col overflow-hidden p-0" aria-describedby={`output-image-preview-${jobId}-${artifact.id}`}>
          <DialogHeader className="shrink-0 border-b border-line px-5 py-3 pr-12">
            <DialogTitle className="truncate text-[14px]">{artifact.name}</DialogTitle>
            <DialogDescription id={`output-image-preview-${jobId}-${artifact.id}`}>{t('preview.large')}</DialogDescription>
          </DialogHeader>
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-canvas p-4 sm:p-8">
            <img src={(large ?? thumb).dataUrl} alt={artifact.name} className="max-h-full max-w-full object-contain shadow-pop" />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
