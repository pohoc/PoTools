import type { JobSnapshot } from 'core';
import { TOOLS } from 'core';
import { Button, Card, EmptyState, Icon, ProgressBar, StateBadge } from '@potools/ui';
import { useI18n } from '../i18n/index.tsx';
import { formatBytes, formatTime } from '../lib/format.ts';
import { jobBadgeTone, jobProgress, jobStateIcon, jobStateLabelKey } from '../lib/jobState.tsx';
import { useJobs } from '../stores/jobs.ts';
import { useNavigate } from 'react-router-dom';

export function JobList({ jobs }: { jobs: JobSnapshot[] }) {
  const { t } = useI18n();
  if (!jobs.length) {
    return <EmptyState icon="queue" title={t('job.none')} hint={t('job.noneHint')} />;
  }
  return (
    <ul className="flex flex-col gap-2">
      {jobs.map((job) => (
        <JobRow key={job.id} job={job} />
      ))}
    </ul>
  );
}

function JobRow({ job }: { job: JobSnapshot }) {
  const { t, tf } = useI18n();
  const navigate = useNavigate();
  const cancel = useJobs((state) => state.cancel);
  const descriptor = TOOLS[job.tool];
  const running = job.progress.state === 'running' || job.progress.state === 'queued';
  const hintKey = (job.error?.details as { hintKey?: string } | undefined)?.hintKey;
  const bytes = job.artifacts.reduce((sum, artifact) => sum + artifact.sizeBytes, 0);

  return (
    <li>
      <Card className="flex flex-col gap-2.5 px-3.5 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control bg-raised text-muted">
            <Icon name={descriptor?.icon ?? 'file'} size={14} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-[13px] font-medium text-ink">{t(descriptor?.nameKey ?? job.tool)}</span>
              {job.fileNames.length ? (
                <span className="min-w-0 truncate text-[11.5px] text-faint">{job.fileNames.join(', ')}</span>
              ) : null}
            </span>
            <span className="text-[11px] text-faint">{formatTime(job.createdAt)}</span>
          </div>
          <StateBadge tone={jobBadgeTone(job.progress.state)} icon={jobStateIcon(job.progress.state)}>{t(jobStateLabelKey(job.progress.state))}</StateBadge>
          <span className="flex shrink-0 items-center gap-1">
            {running ? (
              <Button size="sm" variant="quiet" icon="close" onClick={() => void cancel(job.id)}>
                {t('job.cancel')}
              </Button>
            ) : (
              <Button size="sm" variant="quiet" icon="chevronRight" onClick={() => navigate(`/tool/${job.tool}`)}>
                {t('job.details')}
              </Button>
            )}
          </span>
        </div>

        {running ? (
          <div className="flex items-center gap-3">
            <ProgressBar percent={job.progress.percent} {...jobProgress(job.progress.state)} />
            <span className="w-[42px] shrink-0 text-right font-mono text-[11.5px] tabular-nums text-muted">
              {Math.round(job.progress.percent)}%
            </span>
          </div>
        ) : null}

        {job.error ? (
          <p className="flex items-start gap-1.5 rounded-control bg-bad/10 px-2.5 py-1.5 text-[12px] leading-5 text-ink">
            <Icon name="warning" size={13} className="mt-[3px] shrink-0 text-bad" />
            {hintKey ? t(hintKey) : job.error.message}
          </p>
        ) : null}

        {job.artifacts.length ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted">
            <span>{tf('result.artifacts', { count: job.artifacts.length })}</span>
            <span>{formatBytes(bytes)}</span>
            {job.artifacts.slice(0, 3).map((artifact) => (
              <span
                key={artifact.id}
                title={artifact.path ?? undefined}
                className="max-w-[220px] truncate rounded bg-raised px-1.5 py-0.5 font-mono text-[11px]"
              >
                {artifact.name}
              </span>
            ))}
            {job.artifacts.length > 3 ? <span>+{job.artifacts.length - 3}</span> : null}
          </div>
        ) : null}
      </Card>
    </li>
  );
}
