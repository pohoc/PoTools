import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  TOOL_LIST,
  TOOL_WORKFLOWS,
  type ToolFormat,
  type ToolWorkflow,
} from 'core';
import { Icon } from '../components/Icon.tsx';
import { Button, Card, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/index.ts';
import { useI18n } from '../i18n/index.tsx';
import { useEngine } from '../stores/engine.ts';
import { useJobs } from '../stores/jobs.ts';

export function Home() {
  const { t } = useI18n();
  const status = useEngine((state) => state.status);
  const jobs = useJobs((state) => state.jobs);
  const [query, setQuery] = useState('');
  const [workflow, setWorkflow] = useState<ToolWorkflow | 'all'>('all');
  const [format, setFormat] = useState<ToolFormat | 'all'>('all');

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return TOOL_LIST.filter((tool) => {
      if (workflow !== 'all' && tool.workflow !== workflow) return false;
      if (format !== 'all' && ![...tool.inputFormats, ...tool.outputFormats].includes(format)) return false;
      if (!needle) return true;
      const haystack = [t(tool.nameKey), t(tool.descKey), tool.id, ...tool.keywords ?? []].join(' ').toLowerCase();
      return needle.split(/\s+/).every((token) => haystack.includes(token));
    });
  }, [format, query, workflow, t]);

  const recentTools = useMemo(() => {
    const seen = new Set<string>();
    return jobs.filter((job) => {
      if (job.progress.state !== 'succeeded' || seen.has(job.tool)) return false;
      seen.add(job.tool);
      return true;
    }).slice(0, 5);
  }, [jobs]);

  const workflowCounts = Object.fromEntries(
    TOOL_WORKFLOWS.map((key) => [key, TOOL_LIST.filter((tool) => tool.workflow === key).length]),
  ) as Record<ToolWorkflow, number>;

  return (
    <div className="mx-auto w-full max-w-[1280px]">
      <header className="border-b border-line pb-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-[21px] font-semibold tracking-tight">{t('home.title')}</h1>
            <p className="mt-1 text-[12.5px] text-muted">{t('app.tagline')}</p>
          </div>
          {status !== 'ready' ? <span className="flex items-center gap-1.5 text-[12px] text-bad"><span className="h-1.5 w-1.5 rounded-full bg-bad" />{t('engine.offline')}</span> : null}
        </div>
        <div className="mt-4 flex max-w-[760px] flex-col gap-2.5 sm:flex-row">
          <label className="relative block min-w-0 flex-1">
            <Icon name="search" size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
            <Input className="h-10 bg-surface pl-9 pr-9 text-[13px]" placeholder={t('search.placeholder')} value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t('search.placeholder')} />
            {query ? <Button type="button" variant="ghost" size="icon-sm" className="absolute right-2.5 top-1/2 h-7 w-7 -translate-y-1/2 border-transparent bg-transparent p-0 text-faint hover:bg-raised hover:text-ink" onClick={() => setQuery('')} aria-label={t('common.close')}><Icon name="close" size={14} /></Button> : null}
          </label>
          <label className="flex shrink-0 items-center gap-2 rounded-control border border-line bg-surface px-2.5 text-[11px] text-muted">
            <span>{t('home.format')}</span>
            <Select value={format} onValueChange={(value) => setFormat(value as ToolFormat | 'all')}>
              <SelectTrigger aria-label={t('home.format')} className="h-8 w-[132px] border-0 bg-transparent px-1.5 shadow-none hover:bg-transparent focus-visible:ring-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem value="all">{t('search.all')}</SelectItem>
                {availableFormats().map((item) => <SelectItem key={item} value={item}>{t(`format.${item}`)}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>
        </div>
      </header>

      {recentTools.length > 0 && !query && workflow === 'all' ? (
        <section className="flex min-w-0 items-center gap-3 overflow-hidden border-b border-line py-2.5" aria-labelledby="recent-tools-heading">
          <h2 id="recent-tools-heading" className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-faint">{t('home.recent')}</h2>
          <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
            {recentTools.map((job) => {
              const tool = TOOL_LIST.find((entry) => entry.id === job.tool);
              return <Button key={job.id} asChild variant="ghost" size="sm" className="h-7 shrink-0 gap-1.5 px-2 text-[11px] text-muted"><Link to={`/tool/${job.tool}`}><Icon name={tool?.icon ?? 'file'} size={13} />{t(tool?.nameKey ?? job.tool)}</Link></Button>;
            })}
          </div>
          <Button asChild variant="link" size="sm" className="ml-auto h-7 shrink-0 px-1 text-[10.5px]"><Link to="/queue">{t('home.viewQueue')}</Link></Button>
        </section>
      ) : null}

      <div className="grid min-h-[520px] grid-cols-1 gap-4 pt-3 lg:grid-cols-[196px_minmax(0,1fr)] lg:gap-0">
        <aside className="min-w-0 border-b border-line pb-3 lg:border-b-0 lg:border-r lg:py-4 lg:pr-3" aria-label={t('home.workflows')}>
          <h2 className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-[.12em] text-faint">{t('home.workflows')}</h2>
          <nav className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0" aria-label={t('home.workflows')}>
            <WorkflowButton active={workflow === 'all'} count={TOOL_LIST.length} label={t('home.allTools')} onClick={() => setWorkflow('all')} />
            {TOOL_WORKFLOWS.map((item) => (
              <WorkflowButton key={item} active={workflow === item} count={workflowCounts[item]} label={t(`workflow.${item}`)} onClick={() => setWorkflow(workflow === item ? 'all' : item)} />
            ))}
          </nav>
        </aside>

        <main className="min-w-0 py-1 lg:py-4 lg:pl-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div><h2 className="text-[15px] font-semibold">{workflow === 'all' ? t('home.allTools') : t(`workflow.${workflow}`)}</h2><p className="mt-0.5 text-[11.5px] text-muted">{filtered.length} {t('home.results')}</p></div>
          </div>
          {filtered.length ? <div className="grid grid-cols-1 gap-2.5 xl:grid-cols-2">
            {filtered.map((tool) => (
              <Card key={tool.id} className="group min-h-[126px] transition hover:border-accent/35 hover:bg-raised/35 hover:shadow-pop">
                <Link to={`/tool/${tool.id}`} className="flex h-full min-h-[126px] flex-col justify-between p-3.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent sm:p-4">
                <span className="flex w-full min-w-0 items-start gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control border border-line bg-canvas text-muted transition group-hover:border-accent/25 group-hover:text-accent"><Icon name={tool.icon} size={17} /></span>
                  <span className="min-w-0 flex-1 pt-0.5">
                    <span className="block truncate text-[13px] font-semibold text-ink">{t(tool.nameKey)}</span>
                    <span className="mt-1 block line-clamp-2 text-[11.5px] leading-[1.55] text-muted">{t(tool.descKey)}</span>
                  </span>
                  <Icon name="chevronRight" size={15} className="mt-1 shrink-0 text-faint transition group-hover:translate-x-0.5 group-hover:text-accent" />
                </span>
                <span className="mt-3 flex min-w-0 items-center gap-2 border-t border-line/70 pt-2.5">
                  <FormatBadges label={t('home.input')} formats={tool.inputFormats} />
                  <Icon name="chevronRight" size={11} className="shrink-0 text-faint" />
                  <FormatBadges label={t('home.output')} formats={tool.outputFormats} />
                </span>
                </Link>
              </Card>
            ))}
          </div> : <p className="border-t border-dashed border-line py-10 text-center text-[12.5px] text-muted">{t('search.empty')}</p>}
        </main>
      </div>
    </div>
  );
}

function FormatBadges({ label, formats }: { label: string; formats: ToolFormat[] }) {
  const { t } = useI18n();
  return <span className="flex items-center gap-1" aria-label={`${label}: ${formats.map((format) => t(`format.${format}`)).join(', ')}`}>
    <span className="text-[9px] text-faint">{label}</span>
    {formats.slice(0, 2).map((format) => <span key={format} className="rounded border border-line bg-surface px-1.5 py-0.5 text-[9.5px] text-muted">{t(`format.${format}`)}</span>)}
    {formats.length > 2 ? <span className="text-[9px] text-faint">+{formats.length - 2}</span> : null}
  </span>;
}

function availableFormats(): ToolFormat[] {
  return [...new Set(TOOL_LIST.flatMap((tool) => [...tool.inputFormats, ...tool.outputFormats]))]
    .sort((a, b) => a.localeCompare(b));
}

function WorkflowButton({ active, count, label, onClick }: { active: boolean; count: number; label: string; onClick: () => void }) {
  return <Button type="button" variant={active ? 'secondary' : 'ghost'} aria-pressed={active} onClick={onClick} className={`min-h-9 h-auto shrink-0 justify-between gap-3 px-2.5 text-left text-[11.5px] lg:w-full ${active ? 'border-transparent bg-accent-soft font-medium text-accent hover:bg-accent-soft' : 'text-muted'}`}><span className="truncate">{label}</span><span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] tabular-nums ${active ? 'bg-accent/10 text-accent' : 'text-faint'}`}>{count}</span></Button>;
}
