import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { TOOL_LIST, type TempCleanResult, type TempUsage } from 'core';
import { Icon } from '../components/Icon.tsx';
import { Button, Section, Segmented, Toggle } from '../components/ui.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import { toast } from 'sonner';
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs.tsx';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger, DialogClose } from '../components/ui/dialog.tsx';
import { useI18n } from '../i18n/index.tsx';
import { DEFAULT_SETTINGS, useSettings } from '../lib/settings.ts';
import { transportMode, useEngine } from '../stores/engine.ts';
import { nativePickDirectory } from '../lib/tauri.ts';
import { pickFiles } from '../lib/files.ts';
import { formatBytes } from '../lib/format.ts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.tsx';
import { Badge } from '../components/ui/badge.tsx';

const PATTERN_TOKENS = ['{name}', '{tool}', '{index}', '{range}', '{date}'];

type TabId = 'appearance' | 'output' | 'storage' | 'advanced' | 'engine' | 'about';

const TABS: { id: TabId; labelKey: string; icon: string }[] = [
  { id: 'appearance', labelKey: 'settings.tab.appearance', icon: 'palette' },
  { id: 'output', labelKey: 'settings.tab.output', icon: 'folder' },
  { id: 'storage', labelKey: 'settings.tab.storage', icon: 'trash' },
  { id: 'advanced', labelKey: 'settings.tab.advanced', icon: 'layers' },
  { id: 'engine', labelKey: 'settings.tab.engine', icon: 'queue' },
  { id: 'about', labelKey: 'settings.tab.about', icon: 'info' },
];

export function SettingsPage() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const tabsRef = useRef<(HTMLButtonElement | null)[]>([]);

  const requested = params.get('tab') as TabId | null;
  const active: TabId = requested && TABS.some((tab) => tab.id === requested) ? requested : 'appearance';

  const select = (id: TabId) => {
    const next = new URLSearchParams(params);
    next.set('tab', id);
    setParams(next, { replace: true });
  };

  return (
    <Tabs
      value={active}
      onValueChange={(next) => select(next as TabId)}
      className="mx-auto grid w-full max-w-[1280px] grid-cols-1 gap-4 lg:grid-cols-[196px_minmax(0,1fr)] lg:gap-0"
    >
      <TabsList
        variant="vertical"
        aria-label={t('nav.settings')}
        className="min-w-0 flex-row items-center gap-1 overflow-x-auto border-b border-line pb-3 lg:sticky lg:top-0 lg:h-fit lg:flex-col lg:items-stretch lg:overflow-visible lg:border-b-0 lg:border-r lg:py-4 lg:pr-3"
      >
        {TABS.map((tab) => (
          <TabsTrigger key={tab.id} value={tab.id} className="min-h-9 gap-2.5 px-2.5 text-left text-[11.5px] lg:w-full">
            <Icon name={tab.icon} size={14} className="shrink-0" />
            {t(tab.labelKey)}
          </TabsTrigger>
        ))}
      </TabsList>

      <div className="min-w-0 py-1 lg:py-4 lg:pl-5">
        {active === 'appearance' ? <AppearanceTab /> : null}
        {active === 'output' ? <OutputTab /> : null}
        {active === 'storage' ? <StorageTab /> : null}
        {active === 'advanced' ? <AdvancedTab /> : null}
        {active === 'engine' ? <EngineTab /> : null}
        {active === 'about' ? <AboutTab /> : null}
      </div>
    </Tabs>
  );
}

function AppearanceTab() {
  const { t } = useI18n();
  const settings = useSettings();
  return (
    <Section title={t('settings.tab.appearance')}>
      <div className="flex flex-col gap-4">
        <Row label={t('settings.theme')}>
          <Segmented
            value={settings.theme}
            onChange={(value) => settings.set('theme', value)}
            options={[
              { value: 'system', label: t('settings.theme.system') },
              { value: 'light', label: t('settings.theme.light') },
              { value: 'dark', label: t('settings.theme.dark') },
            ]}
          />
        </Row>
        <Row label={t('settings.language')}>
          <Segmented
            value={settings.locale}
            onChange={(value) => settings.set('locale', value)}
            options={[
              { value: 'zh-CN', label: '简体中文' },
              { value: 'en', label: 'English' },
            ]}
          />
        </Row>
        <Row label={t('settings.sidebar')}>
          <Toggle
            checked={settings.sidebarCollapsed}
            onChange={(value) => settings.set('sidebarCollapsed', value)}
            label={t('settings.compactSidebar')}
          />
        </Row>
      </div>
    </Section>
  );
}

function OutputTab() {
  const { t } = useI18n();
  const settings = useSettings();
  const info = useEngine((state) => state.info);

  const chooseDir = async () => {
    const dir = await nativePickDirectory();
    if (dir) settings.set('outputDir', dir);
  };

  return (
    <Section title={t('settings.tab.output')}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="output-dir">{t('settings.outputDir')}</Label>
          <span className="flex gap-2">
            <Input
              id="output-dir"
              className="font-mono"
              placeholder="/Users/you/Documents"
              value={settings.outputDir ?? ''}
              onChange={(event) => settings.set('outputDir', event.target.value || null)}
            />
            <Button variant="ghost" icon="folder" className="shrink-0" onClick={() => void chooseDir()}>
              {t('settings.choose')}
            </Button>
          </span>
          <span className="text-[11.5px] leading-4 text-faint">
            {transportMode() === 'tauri'
              ? t('settings.outputDirHint')
              : `${t('settings.outputDirHint')} · ${t('engine.mode.web')}`}
          </span>
          {info?.defaultOutputDir ? (
            <span className="flex min-w-0 items-center gap-2 text-[11.5px] text-faint">
              <span className="shrink-0">{t('settings.defaultDir')}</span>
              <span className="min-w-0 truncate font-mono" title={info.defaultOutputDir}>
                {info.defaultOutputDir}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-6 shrink-0 px-1.5 text-[11px]"
                onClick={() => settings.set('outputDir', info.defaultOutputDir)}
              >
                {t('settings.useDefault')}
              </Button>
            </span>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="name-pattern">{t('settings.pattern')}</Label>
          <Input
            id="name-pattern"
            className="font-mono"
            value={settings.namePattern}
            onChange={(event) => settings.set('namePattern', event.target.value)}
          />
          <span className="flex flex-wrap items-center gap-1">
            {PATTERN_TOKENS.map((token) => (
              <Button
                key={token}
                type="button"
                variant="outline"
                size="sm"
                className="kbd h-6 px-1.5 font-mono text-[11px]"
                onClick={() =>
                  settings.set(
                    'namePattern',
                    settings.namePattern.includes(token) ? settings.namePattern : `${settings.namePattern}${token}`,
                  )
                }
              >
                {token}
              </Button>
            ))}
          </span>
          <span className="text-[11.5px] leading-4 text-faint">{t('settings.patternHint')}</span>
        </div>

        <Toggle
          checked={settings.autoOpen}
          onChange={(value) => settings.set('autoOpen', value)}
          label={t('settings.autoOpen')}
        />
      </div>
    </Section>
  );
}

function StorageTab() {
  const { t, tf } = useI18n();
  const info = useEngine((state) => state.info);
  const call = useEngine((state) => state.call);
  const settings = useSettings();
  const [usage, setUsage] = useState<TempUsage | null>(null);

  const refresh = useCallback(() => {
    call<TempUsage>('temp.stat', {})
      .then(setUsage)
      .catch(() => setUsage(null));
  }, [call]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const clean = async (olderThanDays: number) => {
    const result = await call<TempCleanResult>('temp.clean', {
      olderThanDays,
      keepJobs: olderThanDays > 0 ? 1 : 0,
    }).catch(() => null);
    if (!result) {
      toast.error(t('settings.cleanFailed'));
      return;
    }
    toast.success(
      result.removedJobs
        ? tf('settings.cleaned', { jobs: result.removedJobs, size: formatBytes(result.freedBytes) })
        : t('settings.nothing'),
    );
    refresh();
  };

  return (
    <Section
      title={t('settings.tab.storage')}
      aside={
        <Button size="sm" variant="quiet" icon="refresh" onClick={refresh}>
          {t('settings.reconnect')}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="field-label">{t('settings.tempDir')}</span>
          <span className="truncate rounded-control bg-raised px-2.5 py-1.5 font-mono text-[12px] text-ink" title={info?.tempDir ?? ''}>
            {info?.tempDir ?? '—'}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label={t('settings.statJobs')} value={String(usage?.jobs ?? '—')} />
          <Stat label={t('settings.statFiles')} value={String(usage?.files ?? '—')} />
          <Stat label={t('settings.statBytes')} value={usage ? formatBytes(usage.bytes) : '—'} />
          <Stat
            label={t('settings.statAge')}
            value={usage?.oldestAt ? `${Math.max(0, Math.round((Date.now() - usage.oldestAt) / 86_400_000))}d` : '—'}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="field-label">{t('settings.tempTtl')}</span>
          <Segmented
            value={settings.tempTtlDays}
            onChange={(value) => settings.set('tempTtlDays', value)}
            options={[0, 1, 7, 30].map((value) => ({ value, label: value === 0 ? t('settings.off') : `${value}` }))}
          />
          <span className="text-[11.5px] leading-4 text-faint">{t('settings.tempTtlHint')}</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" icon="trash" onClick={() => void clean(settings.tempTtlDays || 7)}>
            {t('settings.cleanNow')}
          </Button>
          <Button variant="quiet" onClick={() => void clean(0)}>
            {t('settings.cleanAll')}
          </Button>
        </div>
      </div>
    </Section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-control border border-line bg-surface px-2.5 py-2">
      <div className="truncate font-mono text-[15px] leading-5 text-ink">{value}</div>
      <div className="truncate text-[11px] text-faint" title={label}>
        {label}
      </div>
    </div>
  );
}

function AdvancedTab() {
  const { t } = useI18n();
  const settings = useSettings();
  const info = useEngine((state) => state.info);

  const chooseFont = async () => {
    const files = await pickFiles('image', false);
    const first = files[0];
    if (first?.path) settings.set('fontPath', first.path);
  };

  return (
    <Section title={t('settings.tab.advanced')}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="field-label">{t('settings.concurrency')}</span>
          <Segmented
            value={settings.concurrency}
            onChange={(value) => settings.set('concurrency', value)}
            options={[1, 2, 3, 4].map((value) => ({ value, label: String(value) }))}
          />
          <span className="text-[11.5px] leading-4 text-faint">{t('settings.concurrencyHint')}</span>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="font-path">{t('settings.font')}</Label>
          <span className="flex gap-2">
            <Input
              id="font-path"
              className="font-mono"
              placeholder={info?.features.cjkFont ?? '/System/Library/Fonts/…'}
              value={settings.fontPath ?? ''}
              onChange={(event) => settings.set('fontPath', event.target.value || null)}
            />
            <Button variant="ghost" icon="file" className="shrink-0" onClick={() => void chooseFont()}>
              {t('drop.browse')}
            </Button>
          </span>
          <span className="text-[11.5px] leading-4 text-faint">{t('settings.fontHint')}</span>
        </div>
      </div>
    </Section>
  );
}

function EngineTab() {
  const { t } = useI18n();
  const info = useEngine((state) => state.info);
  const status = useEngine((state) => state.status);
  const reconnect = useEngine((state) => state.reconnect);

  const fontPath = info?.features.cjkFont ?? null;
  const rasterOk = info?.features.rasterizer === 'mupdf';
  const codecOk = Boolean(info?.features.imageCodec);
  const platform =
    info?.platform === 'darwin' ? 'macOS' : info?.platform === 'win32' ? 'Windows' : info?.platform ?? '—';

  return (
    <Section
      title={t('settings.tab.engine')}
      aside={
        <Button size="sm" variant="quiet" icon="refresh" onClick={() => void reconnect()}>
          {t('settings.reconnect')}
        </Button>
      }
    >
      <p className="text-[12px] leading-5 text-muted">{t('settings.engineIntro')}</p>
      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
        <Info
          label={t('settings.engineStatus')}
          value={
            status === 'ready'
              ? t('settings.engineStatus.ready')
              : status === 'connecting'
                ? t('settings.engineStatus.connecting')
                : t('settings.engineStatus.offline')
          }
          tone={status === 'ready' ? 'ok' : status === 'connecting' ? 'warn' : 'bad'}
        />
        <Info
          label={t('settings.runMode')}
          value={transportMode() === 'tauri' ? t('settings.engineMode.tauri') : t('settings.engineMode.web')}
        />
        <Info label={t('settings.engineVersion')} value={info ? `${info.name} ${info.version}` : '—'} />
        <Info label={t('settings.engineNode')} value={info?.nodeVersion ?? '—'} />
        <Info label={t('settings.engineProtocol')} value={info ? `JSON-RPC v${info.protocol}` : '—'} />
        <Info label={t('settings.enginePid')} value={info ? String(info.pid) : '—'} />
        <Info label={t('settings.platform')} value={platform} />
        <Info
          wide
          label={t('settings.rasterizer')}
          value={rasterOk ? t('settings.engineRaster.mupdf') : t('settings.engineRaster.none')}
          tone={rasterOk ? 'ok' : 'warn'}
        />
        <Info
          wide
          label={t('settings.imageCodec')}
          value={codecOk ? t('settings.engineCodec.sharp') : t('settings.engineCodec.none')}
          tone={codecOk ? 'ok' : 'warn'}
        />
        <div className="col-span-full flex min-w-0 items-baseline gap-2 border-t border-line/70 py-1.5">
          <dt className="w-[112px] shrink-0 text-[11.5px] text-faint">{t('settings.detectedFont')}</dt>
          <dd className="min-w-0 flex-1" title={fontPath ?? ''}>
            <span className={`block text-[12px] ${fontPath ? 'text-ok' : 'text-warn'}`}>
              {fontPath ? t('settings.engineFont.ok') : t('settings.engineFont.none')}
            </span>
            <span className="block break-all font-mono text-[11.5px] text-faint">{fontPath ?? '—'}</span>
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-[11.5px] leading-5 text-faint">
        {status === 'ready' ? t('settings.engineProtocolHint') : t('engine.offlineHint')}
      </p>
    </Section>
  );
}

function AboutTab() {
  const { t } = useI18n();
  const info = useEngine((state) => state.info);
  const workflows = ['page-management', 'page-layout', 'annotation', 'conversion', 'extraction', 'optimization', 'metadata', 'image-processing'] as const;
  const counts = workflows.map((workflow) => ({ workflow, count: TOOL_LIST.filter((tool) => tool.workflow === workflow).length }));

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="bg-gradient-to-br from-accent-soft/70 via-surface to-surface p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3.5">
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-accent/15 bg-surface text-accent shadow-card">
                <Icon name="wrench" size={22} />
              </span>
              <div className="min-w-0">
                <h2 className="text-[18px] font-semibold tracking-tight text-ink">PoTools</h2>
                <p className="mt-1 max-w-[620px] text-[12.5px] leading-5 text-muted">{t('settings.aboutIntro')}</p>
              </div>
            </div>
            <Badge variant="outline" className="border-ok/20 bg-ok/8 text-ok"><Icon name="shield" size={12} />{t('settings.privacy')}</Badge>
          </div>
          <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <AboutStat value={String(TOOL_LIST.length)} label={t('settings.aboutTools')} />
            <AboutStat value={String(workflows.length)} label={t('settings.aboutWorkflows')} />
            <AboutStat value={String(new Set(TOOL_LIST.flatMap((tool) => tool.inputFormats)).size)} label={t('settings.aboutFormats')} />
            <AboutStat value={info?.platform ?? '—'} label={t('settings.platform')} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="px-4 py-3">
          <CardTitle>{t('settings.aboutCapabilities')}</CardTitle>
          <CardDescription>{t('settings.aboutCapabilitiesHint')}</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2">
          {counts.filter((item) => item.count > 0).map(({ workflow, count }) => (
            <div key={workflow} className="flex min-w-0 items-center gap-2.5 rounded-control border border-line/80 bg-canvas/60 px-3 py-2.5">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control bg-accent-soft text-accent"><Icon name={workflowIcon(workflow)} size={14} /></span>
              <span className="min-w-0 flex-1 text-[12px] text-ink">{t(`workflow.${workflow}`)}</span>
              <Badge variant="outline" className="px-1.5 py-0 text-[10.5px]">{count}</Badge>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="px-4 py-3">
          <CardTitle>{t('settings.aboutPrivacy')}</CardTitle>
          <CardDescription>{t('settings.aboutPrivacyHint')}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 p-4 sm:grid-cols-3">
          {(['local', 'control', 'cleanup'] as const).map((item, index) => (
            <div key={item} className="flex items-start gap-2.5">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ok/10 text-ok"><Icon name={index === 0 ? 'shield' : index === 1 ? 'settings' : 'trash'} size={13} /></span>
              <p className="text-[11.5px] leading-5 text-muted">{t(`settings.aboutPrivacy.${item}`)}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      <Section title={t('settings.about')}>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1 rounded-control bg-raised px-3 py-2">
            <div className="flex items-center justify-between gap-3">
            <span className="shrink-0 text-[11.5px] text-faint">{t('settings.author')}</span>
            <span className="min-w-0 truncate text-[12px] text-ink">pohoc</span>
            </div>
            <div className="flex items-center justify-between gap-3">
            <span className="shrink-0 text-[11.5px] text-faint">{t('settings.contact')}</span>
            <a href="mailto:po.hoc4@gmail.com" className="min-w-0 truncate font-mono text-[12px] text-accent hover:underline">
              po.hoc4@gmail.com
            </a>
            </div>
            <div className="flex items-center justify-between gap-3">
            <span className="shrink-0 text-[11.5px] text-faint">{t('settings.version')}</span>
            <span className="min-w-0 truncate font-mono text-[12px] text-ink">
              app 0.1.0 · engine {info?.version ?? '0.1.0'}
            </span>
            </div>
            <div className="flex items-center justify-between gap-3">
            <span className="shrink-0 text-[11.5px] text-faint">{t('settings.runMode')}</span>
            <span className="min-w-0 truncate text-[12px] text-ink">{transportMode() === 'tauri' ? t('settings.engineMode.tauri') : t('settings.engineMode.web')}</span>
            </div>
          </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] text-faint">{t('settings.copyright')}</span>
          <ResetDialog />
        </div>
      </div>
      </Section>
    </div>
  );
}

function AboutStat({ value, label }: { value: string; label: string }) {
  return <div className="rounded-control border border-line/80 bg-surface/85 px-3 py-2"><div className="font-mono text-[16px] font-semibold text-ink">{value}</div><div className="mt-0.5 text-[10.5px] text-faint">{label}</div></div>;
}

function workflowIcon(workflow: string): string {
  const icons: Record<string, string> = {
    'page-management': 'layout-grid', 'page-layout': 'frame', annotation: 'type', conversion: 'refresh',
    extraction: 'file', optimization: 'minimize', metadata: 'info', 'image-processing': 'images',
  };
  return icons[workflow] ?? 'file';
}

/** Destructive action gets a real confirmation instead of firing on click. */
function ResetDialog() {
  const { t } = useI18n();
  const settings = useSettings();
  const [open, setOpen] = useState(false);

  const reset = () => {
    (Object.keys(DEFAULT_SETTINGS) as (keyof typeof DEFAULT_SETTINGS)[]).forEach((key) =>
      settings.set(key, DEFAULT_SETTINGS[key]),
    );
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" icon="reset">
          {t('settings.reset')}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('settings.resetTitle')}</DialogTitle>
          <DialogDescription>{t('settings.resetHint')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" size="sm">
              {t('common.cancel')}
            </Button>
          </DialogClose>
          <Button variant="danger" size="sm" onClick={reset}>
            {t('settings.reset')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-[13px] text-ink">{label}</span>
      {children}
    </div>
  );
}

function Info({
  label,
  value,
  tone,
  wide,
}: {
  label: string;
  value: string;
  tone?: 'ok' | 'warn' | 'bad';
  wide?: boolean;
}) {
  const color = tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : tone === 'bad' ? 'text-bad' : 'text-ink';
  return (
    <div className={`flex min-w-0 items-baseline gap-2 border-b border-line/70 py-1.5 ${wide ? 'col-span-full' : ''}`}>
      <dt className="w-[112px] shrink-0 text-[11.5px] text-faint">{label}</dt>
      <dd className={`min-w-0 flex-1 text-[12px] ${wide ? '' : 'break-words'} ${color}`} title={value}>
        {value}
      </dd>
    </div>
  );
}
