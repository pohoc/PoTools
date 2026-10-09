import { useMemo, useState } from 'react';
import type { JobSnapshot, OutputFile, TextRunResult } from 'core';
import { FilePreviewDialog } from './FilePreviewDialog.tsx';
import { TOOLS } from '../lib/core-bindings.ts';
import { useJobs } from '../stores/jobs.ts';
import {
  Button, EmptyState, Icon, ProgressBar, Section, StateBadge, toast,
} from '@potools/ui';
import { useI18n } from '../i18n/index.tsx';
import { localizedErrorText } from '../lib/error-text.ts';
import { jobBadgeTone, jobProgress, jobStateIcon, jobStateLabelKey } from '../lib/jobState.tsx';
import { formatBytes, formatDuration } from '../lib/format.ts';
import {
  chooseSaveDir,
  downloadArtifact,
  revealArtifact,
  saveArtifactToFolder,
  saveAllToFolder,
  saveArtifactAs,
} from '../lib/files.ts';
import { isTauri } from '../lib/tauri.ts';
import { rpcErrorMessage } from '../stores/engine.ts';
import { useSettings } from '../lib/settings.ts';
import { useEngine } from '../stores/engine.ts';

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
  const info = useEngine((state) => state.info);
  const outputDir = settings.outputDir || info?.defaultOutputDir || '';
  // Click-to-preview replaces the per-row thumbnail: the name opens the same
  // unified viewer dialog the input side uses, and a split's fifteen rows stop
  // paying for a thumbnail render each.
  const [previewing, setPreviewing] = useState<OutputFile | null>(null);

  if (!job) {
    return (
      <Section title={t('result.title')}>
        <EmptyState className="tool-empty-result" icon="file" title={t('result.empty')} hint={t('result.noDir')} />
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
    } catch (issue) {
      toast.error(issue instanceof Error ? issue.message : t('result.saveFailed'));
    }
  };

  const saveOne = async (artifact: OutputFile) => {
    try {
      const dir = await chooseSaveDir();
      if (!dir) {
        await downloadArtifact(artifact);
        return;
      }
      const path = await saveArtifactToFolder(job.id, artifact, dir);
      if (path) toast.success(tf('result.savedTo', { path }));
    } catch (issue) {
      toast.error(issue instanceof Error ? issue.message : t('result.saveFailed'));
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
          <StateBadge tone={jobBadgeTone(job.progress.state)} icon={jobStateIcon(job.progress.state)}>{t(jobStateLabelKey(job.progress.state))}</StateBadge>
        </span>
      }
      aside={
        <span className="flex shrink-0 items-center gap-2">
          {job.artifacts.some((artifact) => !artifact.stagedMissing) ? (
            <Button
              size="sm"
              variant="ghost"
              icon="save"
              onClick={() => void saveAll()}
            >
              {t('result.saveAllTo')}
            </Button>
          ) : null}
          {onRetry ? (
            <Button
              size="sm"
              variant="ghost"
              icon="reset"
              onClick={() => {
                void (async () => {
                  // Replay the exact original request; the draft may have
                  // changed (or gone) since the job completed.
                  const reran = await useJobs.getState().resubmit(job.id);
                  if (!reran) onRetry();
                })();
              }}
            >
              {t('result.rerun')}
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
          <ProgressBar percent={job.progress.percent} {...jobProgress(job.progress.state)} />
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
            <p className="text-[12.5px] leading-5 text-ink">{localizedErrorText(error, t)}</p>
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
              <Icon name={kindIcon(artifact)} size={15} className="shrink-0 text-faint" />
              <span className="min-w-0 flex-1">
              {artifact.kind === 'image' || artifact.kind === 'pdf' ? (
                <button
                  type="button"
                  title={t('preview.large')}
                  onClick={() => setPreviewing(artifact)}
                  className="block max-w-full truncate rounded-sm text-left text-[12.5px] leading-5 text-ink outline-none transition hover:text-accent hover:underline focus-visible:underline focus-visible:ring-2 focus-visible:ring-accent/40"
                >
                  {artifact.name}
                </button>
              ) : (
                <span className="block truncate text-[12.5px] leading-5 text-ink" title={artifact.path ?? artifact.name}>
                  {artifact.name}
                </span>
              )}
                <span className="block text-[11px] leading-4 text-faint">
                  {formatBytes(artifact.sizeBytes)}
                  {artifact.page ? ` · p${artifact.page}` : ''}
                  {artifact.stagedMissing
                    ? ` · ${t('result.tempCleaned')}`
                    : artifact.path ? '' : ` · ${t('result.inTemp')}`}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1">
                {artifact.path ? (
                  <Button size="sm" variant="quiet" icon="printer" title={t('result.print')} onClick={() => void printOne(artifact)}>
                    {t('result.printShort')}
                  </Button>
                ) : null}
                {artifact.path && !artifact.stagedMissing ? (
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
                {isTauri() ? null : (
                  <Button size="sm" variant="quiet" icon="download" onClick={() => void downloadArtifact(artifact)}>
                    {t('result.downloadShort')}
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex items-center gap-2 border-t border-line px-4 py-2 text-[11.5px] text-faint">
        <Icon name="folder" size={13} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate" title={outputDir}>{outputDir || t('result.noDir')}</span>
        {isTauri() && job.artifacts.some((artifact) => artifact.path && !artifact.stagedMissing) ? (
          <Button
            size="sm"
            variant="outline"
            icon="folder"
            className="h-7 shrink-0 rounded-control px-2 text-[11px]"
            onClick={() => {
              const first = job.artifacts.find((artifact) => artifact.path && !artifact.stagedMissing);
              if (first) void revealArtifact(first);
            }}
          >
            {t('result.revealFolder')}
          </Button>
        ) : null}
      </div>
      <FilePreviewDialog
        target={previewing ? {
          name: previewing.name,
          path: previewing.path,
          dataBase64: previewing.path ? undefined : previewing.dataBase64,
        } : null}
        onClose={() => setPreviewing(null)}
      />
    </Section>
  );
}

interface TextBlock {
  name: string;
  text: string;
  base64: string;
  sizeBytes: number;
  summary?: string;
}

function splitTextReport(text: string): { preview: string; details: string } {
  const headings = [...text.matchAll(/^── .*$/gm)];
  if (headings.length < 3) return { preview: text, details: '' };
  const secondDetailStart = headings[2]?.index ?? text.length;
  return {
    preview: text.slice(0, secondDetailStart).trimEnd(),
    details: text.slice(secondDetailStart).trimStart(),
  };
}

function decodeBase64Text(base64: string): string {
  try {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return '';
  }
}

function encodeBase64Text(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Instant results of `tool.run`: shown in memory, copied or saved on demand. */
export function TextRunPanel({
  defaultName,
  result,
  error,
  errorCode,
  running,
  onRetry,
}: {
  defaultName: string;
  result: TextRunResult | null;
  error: string | null;
  errorCode: string | null;
  running: boolean;
  onRetry?: () => void;
}) {
  const { t, tf } = useI18n();

  const blocks = useMemo<TextBlock[]>(() => {
    if (!result) return [];
    const textual = result.artifacts.filter((artifact) =>
      (artifact.kind === 'text' || artifact.kind === 'json') && Boolean(artifact.dataBase64),
    );
    if (textual.length) {
      return textual.map((artifact) => ({
        name: artifact.name,
        text: decodeBase64Text(artifact.dataBase64 ?? ''),
        base64: artifact.dataBase64 ?? '',
        sizeBytes: artifact.sizeBytes,
        summary: artifact.name === 'password-gen.txt' && result.extra
          ? tf('result.passwordSummary', { count: result.extra.count ?? '', length: result.extra.length ?? '' })
          : undefined,
      }));
    }
    if (!result.text) return [];
    return [{
      name: defaultName,
      text: result.text,
      base64: encodeBase64Text(result.text),
      sizeBytes: new TextEncoder().encode(result.text).byteLength,
    }];
  }, [defaultName, result, tf]);
  const binaryArtifacts = (result?.artifacts ?? []).filter((artifact) => artifact.kind === 'binary').map((artifact, index) => ({
    ...artifact,
    id: `inline-binary-${index}`,
    kind: 'binary' as const,
  }));

  const copyAll = async () => {
    const text = blocks.map((block) => block.text).join('\n\n');
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t('common.copied'));
    } catch {
      toast.error(t('common.copyFailed'));
    }
  };

  return (
    <Section
      title={t('result.title')}
      aside={
        blocks.length && !running ? (
          <Button size="sm" variant="quiet" icon="copy" onClick={() => void copyAll()}>
            {t('common.copyAll')}
          </Button>
        ) : null
      }
      dense
    >
      {error ? (
        <div className="mx-4 mb-3 flex items-start gap-2 rounded-control border border-bad/30 bg-bad/10 px-3 py-2.5">
          <Icon name="warning" size={15} className="mt-[1px] shrink-0 text-bad" />
          <div className="min-w-0">
            <p className="text-[12.5px] leading-5 text-ink">{error}</p>
            {errorCode ? <p className="mt-0.5 font-mono text-[11px] text-faint">{errorCode}</p> : null}
          </div>
          {onRetry ? (
            <Button size="sm" variant="ghost" icon="reset" className="ml-auto shrink-0" onClick={onRetry}>
              {t('job.retry')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {running ? (
        <p className="mx-4 mb-3 rounded-control bg-raised px-3 py-2.5 text-[12px] text-muted">{t('run.running')}</p>
      ) : null}

      {result?.warnings.length ? (
        <ul className="mx-4 mb-3 flex flex-col gap-1 rounded-control bg-warn/10 px-3 py-2.5">
          {result.warnings.map((warning, index) => (
            <li key={index} className="flex items-start gap-1.5 text-[12px] leading-5 text-ink">
              <Icon name="warning" size={13} className="mt-[3px] shrink-0 text-warn" />
              {warning}
            </li>
          ))}
        </ul>
      ) : null}

      {blocks.length ? (
        <div className="mb-3 flex flex-col gap-2 px-4">
          {blocks.map((block) => (
            <TextBlockCard key={`${block.name}:${block.sizeBytes}`} block={block} />
          ))}
        </div>
      ) : null}

      {binaryArtifacts.length ? (
        <ul className="mb-3 flex flex-col gap-2 px-4">
          {binaryArtifacts.map((artifact) => <TextBinaryFileCard key={artifact.id} artifact={artifact} />)}
        </ul>
      ) : null}

      {!blocks.length && !binaryArtifacts.length && (error || running) ? null : !blocks.length && !binaryArtifacts.length ? (
        <EmptyState icon="file" title={t('result.empty')} hint={t('result.textEmpty')} />
      ) : null}

    </Section>
  );
}

function TextBinaryFileCard({ artifact }: { artifact: OutputFile }) {
  const { t } = useI18n();
  const save = async () => {
    try {
      if (isTauri()) await saveArtifactAs(artifact);
      else await downloadArtifact(artifact);
    } catch {
      toast.error(t('result.saveFailed'));
    }
  };
  return (
    <li className="flex items-center gap-2.5 rounded-control border border-line bg-canvas px-2.5 py-2">
      <Icon name="file" size={15} className="shrink-0 text-faint" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] text-ink">{artifact.name}</span>
        <span className="text-[11px] text-faint">{formatBytes(artifact.sizeBytes)}</span>
      </span>
      <Button size="sm" variant="quiet" icon="download" onClick={() => void save()}>{t(isTauri() ? 'result.save' : 'result.download')}</Button>
    </li>
  );
}

function TextBlockCard({
  block,
}: {
  block: TextBlock;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const passwords = block.name === 'password-gen.txt' ? block.text.split(/\r?\n/).filter(Boolean) : null;
  const colorValue = block.name === 'color-values.txt' ? block.text.match(/(?:^|\n)HEX:\s*(#[\da-f]{6})/i)?.[1] : null;
  const report = useMemo(() => splitTextReport(block.text), [block.text]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(block.text);
      setCopied(true);
      toast.success(t('common.copied'));
      setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error(t('common.copyFailed'));
    }
  };

  return (
    <div className="min-w-0 overflow-hidden rounded-control border border-line bg-canvas">
      <div className="flex items-center gap-2 border-b border-line px-2.5 py-1.5">
        <Icon name="file-text" size={14} className="shrink-0 text-faint" />
        <span className="min-w-0 flex-1 truncate text-[12px] text-muted" title={block.name}>{block.name}</span>
        <span className="shrink-0 text-[11px] text-faint">{formatBytes(block.sizeBytes)}</span>
        <Button
          size="sm"
          variant="quiet"
          icon={copied ? 'check' : 'copy'}
          title={t(copied ? 'common.copied' : 'common.copy')}
          onClick={() => void copy()}
        >
          {copied ? t('common.copied') : t('common.copy')}
        </Button>
      </div>
      {block.summary ? <p className="border-b border-line px-3 py-2 text-[12px] text-muted">{block.summary}</p> : null}
      {colorValue ? (
        <div className="flex items-center gap-3 border-b border-line px-3 py-3">
          <span aria-label={`${t('result.colorPreview')} ${colorValue}`} className="h-12 w-12 shrink-0 rounded-control border border-line shadow-sm" style={{ backgroundColor: colorValue }} />
          <span className="min-w-0">
            <span className="block text-[11px] text-muted">{t('result.colorPreview')}</span>
            <code className="font-mono text-[15px] font-semibold tracking-wide text-ink">{colorValue.toUpperCase()}</code>
          </span>
        </div>
      ) : null}
      {passwords?.length ? (
        <ol className="divide-y divide-line">
          {passwords.map((password, index) => <PasswordValueRow key={`${index}:${password}`} index={index} value={password} />)}
        </ol>
      ) : block.text ? (
        <>
          <pre className="max-h-[420px] min-w-0 select-text overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-[12px] leading-5 text-ink">
            {report.preview}
          </pre>
          {report.details ? (
            <details className="border-t border-line">
              <summary className="cursor-pointer px-3 py-2 text-[12px] text-muted hover:text-ink">{t('result.moreDetails')}</summary>
              <pre className="max-h-[420px] min-w-0 select-text overflow-auto whitespace-pre-wrap break-words border-t border-line bg-raised px-3 py-2.5 font-mono text-[12px] leading-5 text-ink">
                {report.details}
              </pre>
            </details>
          ) : null}
        </>
      ) : (
        <p className="px-3 py-2.5 text-[12px] text-faint">{t('result.noText')}</p>
      )}
    </div>
  );
}

function PasswordValueRow({ index, value }: { index: number; value: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(t('common.copied'));
      setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error(t('common.copyFailed'));
    }
  };

  return (
    <li className="flex min-w-0 items-center gap-2 px-3 py-2">
      <span className="w-6 shrink-0 text-right text-[11px] tabular-nums text-faint">{index + 1}</span>
      <code className="min-w-0 flex-1 select-text break-all font-mono text-[13px] text-ink">{value}</code>
      <Button size="sm" variant="quiet" icon={copied ? 'check' : 'copy'} title={`${t('common.copy')} ${index + 1}`} aria-label={`${t('common.copy')} ${index + 1}`} onClick={() => void copy()}>
        {copied ? t('common.copied') : t('common.copy')}
      </Button>
    </li>
  );
}
