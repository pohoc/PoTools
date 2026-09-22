import { Icon } from '@potools/ui';
import { Button, EmptyState } from '@potools/ui';
import { JobList } from '../components/JobQueue.tsx';
import { Badge } from '@potools/ui';
import { PageLayout, PageSection } from '../components/PageLayout.tsx';
import { useI18n } from '../i18n/index.tsx';
import { useJobs } from '../stores/jobs.ts';

export function QueuePage() {
  const { t } = useI18n();
  const jobs = useJobs((state) => state.jobs);
  const clearFinished = useJobs((state) => state.clearFinished);
  const refresh = useJobs((state) => state.refresh);
  const active = jobs.filter((job) => job.progress.state === 'running' || job.progress.state === 'queued').length;

  return (
    <PageLayout title={t('nav.queue')} description={t('settings.aboutText')}>
      <PageSection
        title={
          <span className="flex items-center gap-2">
            {t('nav.queue')}
            {active ? (
              <Badge>{active}</Badge>
            ) : null}
          </span>
        }
        actions={
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
      </PageSection>
      <p className="flex items-center gap-1.5 px-1 text-[11.5px] text-faint">
        <Icon name="shield" size={13} />
        {t('settings.aboutText')}
      </p>
    </PageLayout>
  );
}
