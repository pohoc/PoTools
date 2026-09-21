import { Icon } from '../components/Icon.tsx';
import { Button, Section, Segmented, Toggle } from '../components/ui.tsx';
import { JobList } from '../components/JobQueue.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { useI18n } from '../i18n/index.tsx';
import { useJobs } from '../stores/jobs.ts';
import { EmptyState } from '../components/ui.tsx';

export function QueuePage() {
  const { t } = useI18n();
  const jobs = useJobs((state) => state.jobs);
  const clearFinished = useJobs((state) => state.clearFinished);
  const refresh = useJobs((state) => state.refresh);
  const active = jobs.filter((job) => job.progress.state === 'running' || job.progress.state === 'queued').length;

  return (
    <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-4">
      <Section
        title={
          <span className="flex items-center gap-2">
            {t('nav.queue')}
            {active ? (
              <Badge>{active}</Badge>
            ) : null}
          </span>
        }
        aside={
          <span className="flex shrink-0 items-center gap-1">
            <Button size="sm" variant="quiet" icon="refresh" onClick={() => void refresh()}>
              {t('settings.reconnect')}
            </Button>
            <Button size="sm" variant="quiet" icon="trash" onClick={() => void clearFinished()}>
              {t('job.clear')}
            </Button>
          </span>
        }
      >
        {jobs.length ? <JobList jobs={jobs} /> : <EmptyState icon="queue" title={t('job.none')} hint={t('job.noneHint')} />}
      </Section>
      <p className="flex items-center gap-1.5 px-1 text-[11.5px] text-faint">
        <Icon name="shield" size={13} />
        {t('settings.aboutText')}
      </p>
    </div>
  );
}
