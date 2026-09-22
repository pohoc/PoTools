import { Icon } from '@potools/ui';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Input as HeroInput } from '@potools/ui';
import {
  TOOL_LIST,
  type ToolDescriptor,
  type ToolFormat,
} from 'core';
import { Card, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Button } from '@potools/ui';
import { useI18n } from '../i18n/index.tsx';
import { useEngine } from '../stores/engine.ts';
import { useJobs } from '../stores/jobs.ts';

export function Home() {
  const { t } = useI18n();
  const status = useEngine((state) => state.status);
  const jobs = useJobs((state) => state.jobs);
  const [query, setQuery] = useState('');
  const [format, setFormat] = useState<ToolFormat | 'all'>('all');
  const [activeCategory, setActiveCategory] = useState<ToolLibraryCategory>(() => {
    try {
      const saved = sessionStorage.getItem('potools.lastCategory');
      return TOOL_CATEGORIES.some((category) => category.id === saved) ? saved as ToolLibraryCategory : 'all';
    } catch { return 'all'; }
  });

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return TOOL_LIST.filter((tool) => {
      if (format !== 'all' && ![...tool.inputFormats, ...tool.outputFormats].includes(format)) return false;
      if (!needle) return true;
      const haystack = [t(tool.nameKey), t(tool.descKey), tool.id, ...tool.keywords ?? []].join(' ').toLowerCase();
      return needle.split(/\s+/).every((token) => haystack.includes(token));
    });
  }, [format, query, t]);

  const categoryGroups = useMemo(() => {
    return TOOL_CATEGORIES.map((category) => ({
      ...category,
      tools: category.id === 'all' ? TOOL_LIST : TOOL_LIST.filter((tool) => classifyTool(tool) === category.id),
    }));
  }, []);

  const sections = useMemo(() => {
    const candidates = query.trim() || activeCategory === 'all'
      ? categoryGroups.filter((group) => group.id !== 'all')
      : categoryGroups.filter((group) => group.id === activeCategory);
    return candidates.map((category) => ({
      ...category,
      tools: category.tools.filter((tool) => filtered.includes(tool)),
    })).filter((category) => category.tools.length > 0);
  }, [activeCategory, categoryGroups, filtered, query]);

  const resultCount = sections.reduce((sum, section) => sum + section.tools.length, 0);
  const recentTools = useMemo(() => {
    const seen = new Set<string>();
    return jobs.filter((job) => {
      if (job.progress.state !== 'succeeded' || seen.has(job.tool)) return false;
      seen.add(job.tool);
      return true;
    }).slice(0, 5);
  }, [jobs]);

  return (
    <div className="page-frame">
      <header className="page-header">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-[21px] font-semibold tracking-tight">{t('home.title')}</h1>
            <p className="mt-1 text-[12.5px] text-muted">{t('app.tagline')}</p>
          </div>
          {status !== 'ready' ? <span className="flex items-center gap-1.5 text-[12px] text-bad"><span className="h-1.5 w-1.5 rounded-full bg-bad" />{t('engine.offline')}</span> : null}
        </div>
        <div className="mt-4 flex max-w-[900px] flex-col gap-2.5 sm:flex-row">
          <label className="relative block min-w-0 flex-1">
            <Icon name="search" size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
            <HeroInput className="h-10 bg-surface pl-9 pr-9 text-[13px]" placeholder={t('search.placeholder')} value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t('search.placeholder')} />
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

      {recentTools.length > 0 && !query && format === 'all' ? (
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

      <nav className="flex gap-1 overflow-x-auto border-b border-line py-2" aria-label={t('home.categories')}>
          {categoryGroups.map((category) => (
            <Button key={category.id} type="button" variant={activeCategory === category.id ? 'secondary' : 'ghost'} aria-pressed={activeCategory === category.id} onClick={() => { setActiveCategory(category.id); setQuery(''); try { sessionStorage.setItem('potools.lastCategory', category.id); } catch { /* ignore */ } }} className={`h-8 shrink-0 gap-1.5 px-2.5 text-[11.5px] ${activeCategory === category.id ? 'border-transparent bg-accent-soft font-medium text-accent hover:bg-accent-soft' : 'text-muted'}`}>
              {t(category.label)}<span className={`text-[10px] tabular-nums ${activeCategory === category.id ? 'text-accent/70' : 'text-faint'}`}>{category.tools.length}</span>
            </Button>
          ))}
        </nav>

      <main className="min-w-0 py-3">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <div><h2 className="text-[15px] font-semibold">{query.trim() ? t('home.searchResults') : t(categoryGroups.find((category) => category.id === activeCategory)?.label ?? 'home.allTools')}</h2><p className="mt-0.5 text-[11.5px] text-muted">{resultCount} {t('home.results')}</p></div>
          </div>
          {sections.length ? <div className="flex flex-col gap-5">
            {sections.map((section) => (
              <section key={section.id} className="min-w-0" aria-labelledby={`tool-category-heading-${section.id}`}>
                {query.trim() && sections.length > 1 ? <h3 id={`tool-category-heading-${section.id}`} className="mb-2 text-[12px] font-semibold text-muted">{t(section.label)}</h3> : null}
                <div className="grid grid-cols-1 items-stretch gap-3 lg:grid-cols-2 xl:grid-cols-3">
                  {section.tools.map((tool) => <ToolCard key={tool.id} tool={tool} />)}
                </div>
              </section>
            ))}
          </div> : <p className="border-t border-dashed border-line py-10 text-center text-[12.5px] text-muted">{query.trim() || format !== 'all' ? t('search.empty') : t('home.categoryEmpty')}</p>}
      </main>
    </div>
  );
}

type ToolLibraryCategory = 'all' | 'pdf' | 'office' | 'finance' | 'image' | 'time' | 'crypto' | 'other';

const TOOL_CATEGORIES: Array<{ id: ToolLibraryCategory; label: string }> = [
  { id: 'all', label: 'home.allTools' },
  { id: 'pdf', label: 'home.category.pdf' },
  { id: 'office', label: 'home.category.office' },
  { id: 'finance', label: 'home.category.finance' },
  { id: 'image', label: 'home.category.image' },
  { id: 'time', label: 'home.category.time' },
  { id: 'crypto', label: 'home.category.crypto' },
  { id: 'other', label: 'home.category.other' },
];

const OFFICE_FORMATS = new Set<ToolFormat>(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx']);

function classifyTool(tool: ToolDescriptor): ToolLibraryCategory {
  if (tool.workflow === 'time') return 'time';
  if (tool.workflow === 'crypto') return 'crypto';
  if (tool.workflow === 'invoice-organizing' || tool.id === 'invoice-merge') return 'finance';
  if (tool.accept.startsWith('image/') || tool.inputFormats.includes('image') || tool.id.startsWith('image-')) return 'image';
  if ([...tool.inputFormats, ...tool.outputFormats].some((format) => OFFICE_FORMATS.has(format))) return 'office';
  if (tool.inputFormats.includes('pdf') || tool.outputFormats.includes('pdf') || tool.accept.includes('application/pdf')) return 'pdf';
  return 'other';
}

function ToolCard({ tool }: { tool: ToolDescriptor }) {
  const { t } = useI18n();
  return (
    <Card className="group min-w-0 overflow-hidden transition hover:border-accent/35 hover:bg-raised/35 hover:shadow-pop">
      <Link to={`/tool/${tool.id}`} className="flex h-full min-w-0 flex-col p-3.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent">
        <span className="flex w-full min-w-0 items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control border border-line bg-canvas text-muted transition group-hover:border-accent/25 group-hover:text-accent"><Icon name={tool.icon} size={17} /></span>
          <span className="min-w-0 flex-1 pt-0.5">
            <span className="block whitespace-normal break-words text-[13px] font-semibold leading-5 text-ink">{t(tool.nameKey)}</span>
            <span className="mt-1 block whitespace-normal break-words text-[11.5px] leading-[1.55] text-muted">{t(tool.descKey)}</span>
          </span>
          <Icon name="chevronRight" size={15} className="mt-1 shrink-0 text-faint transition group-hover:translate-x-0.5 group-hover:text-accent" />
        </span>
        <div className="mt-3 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-line/70 pt-2.5">
          <FormatBadges label={t('home.input')} formats={tool.inputFormats} />
          <Icon name="chevronRight" size={11} className="shrink-0 text-faint" />
          <FormatBadges label={t('home.output')} formats={tool.outputFormats} />
        </div>
      </Link>
    </Card>
  );
}

function FormatBadges({ label, formats }: { label: string; formats: ToolFormat[] }) {
  const { t } = useI18n();
  const uniqueFormats = [...new Set(formats)];
  return <span className="flex min-w-0 flex-wrap items-center gap-1" aria-label={`${label}: ${uniqueFormats.map((format) => t(`format.${format}`)).join(', ')}`}>
    <span className="shrink-0 whitespace-nowrap text-[9px] text-faint">{label}</span>
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {uniqueFormats.map((format) => {
        const name = t(`format.${format}`);
        return <span key={format} title={name} className="whitespace-nowrap rounded border border-line bg-surface px-1.5 py-0.5 text-[9.5px] leading-4 text-muted">{name}</span>;
      })}
    </span>
  </span>;
}

function availableFormats(): ToolFormat[] {
  return [...new Set(TOOL_LIST.flatMap((tool) => [...tool.inputFormats, ...tool.outputFormats]))]
    .sort((a, b) => a.localeCompare(b));
}
