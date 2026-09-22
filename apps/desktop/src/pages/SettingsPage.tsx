import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { type TempCleanResult, type TempUsage } from 'core';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  cn,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Icon,
  toast,
  Input,
  Label,
  Segmented,
  Switch,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@potools/ui';
import { SettingsLayout } from '../components/PageLayout.tsx';
import { useI18n } from '../i18n/index.tsx';
import { DEFAULT_SETTINGS, useSettings } from '../lib/settings.ts';
import { transportMode, useEngine } from '../stores/engine.ts';
import { isTauri, nativePickDirectory } from '../lib/tauri.ts';
import { pickFiles } from '../lib/files.ts';
import { formatBytes } from '../lib/format.ts';
import { APP_VERSION } from '../lib/version.ts';

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

  const requested = params.get('tab') as TabId | null;
  const active: TabId = requested && TABS.some((tab) => tab.id === requested) ? requested : 'appearance';

  const select = (id: TabId) => {
    const next = new URLSearchParams(params);
    next.set('tab', id);
    setParams(next, { replace: true });
  };

  return (
    <SettingsLayout
      title={t('nav.settings')}
      description={t('settings.aboutText')}
      tabs={TABS.map((tab) => ({ id: tab.id, label: t(tab.labelKey), icon: tab.icon }))}
      active={active}
      onChange={(next) => select(next as TabId)}
    >
      {active === 'appearance' ? <AppearanceTab /> : null}
      {active === 'output' ? <OutputTab /> : null}
      {active === 'storage' ? <StorageTab /> : null}
      {active === 'advanced' ? <AdvancedTab /> : null}
      {active === 'engine' ? <EngineTab /> : null}
      {active === 'about' ? <AboutTab /> : null}
    </SettingsLayout>
  );
}

/** One card per group: header row on top, hairline-separated settings below. */
function Group({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="min-w-0 rounded-card border border-line bg-surface shadow-card ring-1 ring-black/[0.02]">
      <CardHeader className="flex flex-row items-start justify-between gap-3 border-b border-line/70 px-5 py-4">
        <div className="min-w-0">
          <CardTitle>{title}</CardTitle>
          {description ? <CardDescription className="mt-0.5">{description}</CardDescription> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-1 px-3 py-2">
        {children}
      </CardContent>
    </Card>
  );
}

/** Label and hint on the left, control pinned to the right edge. */
function SettingRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="group flex min-w-0 flex-wrap items-center justify-between gap-x-6 gap-y-2 rounded-control px-2 py-3 transition hover:bg-raised/45">
      <div className="min-w-0 flex-1">
        <span className="block text-[13px] leading-5 text-ink">{label}</span>
        {hint ? <span className="mt-0.5 block text-[11.5px] leading-4 text-faint">{hint}</span> : null}
      </div>
      <div className="settings-row-control flex shrink-0 items-center justify-end gap-2">{children}</div>
    </div>
  );
}

/** Stacked row for controls that need the full width, such as text fields. */
function FieldRow({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-control px-2 py-3">
      <Label htmlFor={htmlFor} className="form-label">
        {label}
      </Label>
      {children}
      {hint ? <p className="form-hint">{hint}</p> : null}
    </div>
  );
}

/** Term/value line shared by the engine and about groups. */
function DefinitionRow({
  term,
  tone,
  title,
  children,
}: {
  term: string;
  tone?: 'ok' | 'warn' | 'bad';
  title?: string;
  children: ReactNode;
}) {
  const color = tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : tone === 'bad' ? 'text-bad' : 'text-ink';
  return (
    <div className="flex min-w-0 items-baseline gap-3 py-2.5">
      <dt className="w-28 shrink-0 truncate text-[11.5px] leading-5 text-faint">{term}</dt>
      <dd className={cn('min-w-0 flex-1 truncate text-[12px] leading-5', color)} title={title}>
        {children}
      </dd>
    </div>
  );
}

function AppearanceTab() {
  const { t } = useI18n();
  const settings = useSettings();
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Group title={t('settings.tab.appearance')}>
        <SettingRow label={t('settings.theme')}>
          <Segmented
            value={settings.theme}
            onChange={(value) => settings.set('theme', value)}
            options={[
              { value: 'system', label: t('settings.theme.system') },
              { value: 'light', label: t('settings.theme.light') },
              { value: 'dark', label: t('settings.theme.dark') },
            ]}
          />
        </SettingRow>
        <SettingRow label={t('settings.language')}>
          <Segmented
            value={settings.locale}
            onChange={(value) => settings.set('locale', value)}
            options={[
              { value: 'zh-CN', label: '简体中文' },
              { value: 'en', label: 'English' },
            ]}
          />
        </SettingRow>
        <SettingRow label={t('settings.sidebar')} hint={t('settings.compactSidebar')}>
          <Switch
            checked={settings.sidebarCollapsed}
            onChange={(value) => settings.set('sidebarCollapsed', value)}
            label={t('settings.compactSidebar')}
          />
        </SettingRow>
      </Group>
    </div>
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
    <div className="flex min-w-0 flex-col gap-4">
      <Group title={t('settings.tab.output')}>
        <FieldRow
          label={t('settings.outputDir')}
          htmlFor="output-dir"
          hint={
            transportMode() === 'tauri'
              ? t('settings.outputDirHint')
              : `${t('settings.outputDirHint')} · ${t('engine.mode.web')}`
          }
        >
          <div className="flex min-w-0 items-center gap-2">
            <Input
              id="output-dir"
              className="min-w-0 flex-1 font-mono"
              placeholder="/Users/you/Documents"
              value={settings.outputDir ?? ''}
              onChange={(event) => settings.set('outputDir', event.target.value || null)}
            />
            <Button variant="primary" size="sm" icon="folder" className="h-8 shrink-0 rounded-control" disabled={!isTauri()} title={isTauri() ? undefined : t('settings.chooseDesktopOnly')} onClick={() => void chooseDir()}>
              {t('settings.choose')}
            </Button>
          </div>
          {info?.defaultOutputDir ? (
            <div className="flex min-w-0 items-center gap-2 text-[11.5px] leading-5 text-faint">
              <span className="shrink-0">{t('settings.defaultDir')}</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="min-w-0 truncate font-mono" title={info.defaultOutputDir}>{info.defaultOutputDir}</span>
                </TooltipTrigger>
                <TooltipContent side="top">{info.defaultOutputDir}</TooltipContent>
              </Tooltip>
              <Button
                type="button"
                variant="quiet"
                size="sm"
                className="h-6 shrink-0 rounded-control px-1.5 text-[11px]"
                onClick={() => settings.set('outputDir', info.defaultOutputDir)}
              >
                {t('settings.useDefault')}
              </Button>
            </div>
          ) : null}
        </FieldRow>

        <FieldRow label={t('settings.pattern')} htmlFor="name-pattern" hint={t('settings.patternHint')}>
          <Input
            id="name-pattern"
            className="font-mono"
            value={settings.namePattern}
            onChange={(event) => settings.set('namePattern', event.target.value)}
          />
          <div className="mt-1 flex flex-wrap items-center gap-1.5" aria-label={t('settings.patternTokens')}>
            {PATTERN_TOKENS.map((token) => (
              <Button
                key={token}
                type="button"
                variant="quiet"
                size="sm"
                className="kbd h-6 shrink-0 px-1.5 font-mono text-[11px]"
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
          </div>
        </FieldRow>

        <SettingRow label={t('settings.autoOpen')}>
          <Switch
            checked={settings.autoOpen}
            onChange={(value) => settings.set('autoOpen', value)}
            label={t('settings.autoOpen')}
          />
        </SettingRow>
      </Group>
    </div>
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
    <div className="flex min-w-0 flex-col gap-4">
      <Group
        title={t('settings.tab.storage')}
        action={
          <Button size="sm" variant="quiet" icon="refresh" className="rounded-control" onClick={refresh}>
            {t('settings.refresh')}
          </Button>
        }
      >
        <FieldRow label={t('settings.tempDir')}>
          <div className="min-w-0 truncate rounded-control bg-raised px-2.5 py-1.5 font-mono text-[12px] leading-5 text-ink" title={info?.tempDir ?? ''}>
            {info?.tempDir ?? '—'}
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
        </FieldRow>

        <SettingRow label={t('settings.tempTtl')} hint={t('settings.tempTtlHint')}>
          <Segmented
            value={settings.tempTtlDays}
            onChange={(value) => settings.set('tempTtlDays', value)}
            options={[0, 1, 7, 30].map((value) => ({ value, label: value === 0 ? t('settings.off') : `${value}` }))}
          />
        </SettingRow>

        <SettingRow label={t('settings.cleanupOnClose')} hint={t('settings.cleanupOnCloseHint')}>
          <Switch
            checked={settings.cleanupTempOnClose}
            onChange={(value) => settings.set('cleanupTempOnClose', value)}
            label={t('settings.cleanupOnClose')}
          />
        </SettingRow>

        <SettingRow label={t('settings.cleanNow')}>
          <Button variant="outline" size="sm" icon="trash" className="rounded-control" onClick={() => void clean(settings.tempTtlDays || 7)}>
            {tf('settings.cleanOlder', { days: settings.tempTtlDays || 7 })}
          </Button>
          <Button variant="danger" size="sm" className="rounded-control" onClick={() => void clean(0)}>
            {t('settings.cleanAll')}
          </Button>
        </SettingRow>
      </Group>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-control border border-line bg-surface px-2.5 py-2">
      <div className="truncate font-mono text-[15px] leading-5 text-ink">{value}</div>
      <div className="truncate text-[11px] leading-4 text-faint" title={label}>
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
    <div className="flex min-w-0 flex-col gap-4">
      <Group title={t('settings.tab.advanced')}>
        <SettingRow label={t('settings.concurrency')} hint={t('settings.concurrencyHint')}>
          <Segmented
            value={settings.concurrency}
            onChange={(value) => settings.set('concurrency', value)}
            options={[1, 2, 3, 4].map((value) => ({ value, label: String(value) }))}
          />
        </SettingRow>

        <FieldRow label={t('settings.font')} htmlFor="font-path" hint={t('settings.fontHint')}>
          <div className="flex min-w-0 items-center gap-2">
            <Input
              id="font-path"
              className="min-w-0 flex-1 font-mono"
              placeholder={info?.features.cjkFont ?? '/System/Library/Fonts/…'}
              value={settings.fontPath ?? ''}
              onChange={(event) => settings.set('fontPath', event.target.value || null)}
            />
            <Button variant="outline" size="sm" icon="file" className="h-8 shrink-0 rounded-control" onClick={() => void chooseFont()}>
              {t('drop.browse')}
            </Button>
          </div>
        </FieldRow>
      </Group>
    </div>
  );
}

function EngineTab() {
  const { t } = useI18n();
  const info = useEngine((state) => state.info);
  const status = useEngine((state) => state.status);
  const error = useEngine((state) => state.error);
  const reconnect = useEngine((state) => state.reconnect);

  const fontPath = info?.features.cjkFont ?? null;
  const rasterOk = info?.features.rasterizer === 'mupdf';
  const codecOk = Boolean(info?.features.imageCodec);
  const platform =
    info?.platform === 'darwin' ? 'macOS' : info?.platform === 'win32' ? 'Windows' : info?.platform ?? '—';

  const statusLabel = status === 'ready' ? t('settings.engineStatus.ready') : t('settings.engineStatus.offline');

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Group
        title={t('settings.engineConnection')}
        action={
          <Button size="sm" variant="quiet" icon="refresh" className="rounded-control" onClick={() => void reconnect()}>
            {t('settings.reconnect')}
          </Button>
        }
      >
        <dl className="flex min-w-0 flex-col">
          <DefinitionRow term={t('settings.engineStatus')} tone={status === 'ready' ? 'ok' : 'bad'}>
            {statusLabel}
          </DefinitionRow>
          <DefinitionRow term={t('settings.runMode')}>
            {transportMode() === 'tauri' ? t('settings.engineMode.tauri') : t('settings.engineMode.web')}
          </DefinitionRow>
        </dl>
        {status !== 'ready' ? (
          <p className={cn('pb-2 text-[11.5px] leading-5', error ? 'text-bad' : 'text-muted')}>
            {error ?? t('engine.offlineHint')}
          </p>
        ) : null}
      </Group>

      <Group title={t('settings.engineRuntime')}>
        <dl className="flex min-w-0 flex-col">
          <DefinitionRow term={t('settings.engineVersion')}>{info ? `${info.name} ${info.version}` : '—'}</DefinitionRow>
          <DefinitionRow term={t('settings.engineNode')}>{info?.nodeVersion ?? '—'}</DefinitionRow>
          <DefinitionRow term={t('settings.engineProtocol')}>{info ? `JSON-RPC v${info.protocol}` : '—'}</DefinitionRow>
          <DefinitionRow term={t('settings.enginePid')}>{info ? String(info.pid) : '—'}</DefinitionRow>
          <DefinitionRow term={t('settings.platform')}>{platform}</DefinitionRow>
        </dl>
      </Group>

      <Group title={t('settings.engineCapabilities')}>
        <dl className="flex min-w-0 flex-col">
          <DefinitionRow term={t('settings.rasterizer')} tone={rasterOk ? 'ok' : 'warn'}>
            {rasterOk ? t('settings.engineRaster.mupdf') : t('settings.engineRaster.none')}
          </DefinitionRow>
          <DefinitionRow term={t('settings.imageCodec')} tone={codecOk ? 'ok' : 'warn'}>
            {codecOk ? t('settings.engineCodec.sharp') : t('settings.engineCodec.none')}
          </DefinitionRow>
          <DefinitionRow term={t('settings.detectedFont')} tone={fontPath ? 'ok' : 'warn'}>
            {fontPath ? t('settings.engineFont.ok') : t('settings.engineFont.none')}
          </DefinitionRow>
          <DefinitionRow term={t('settings.fontPath')} title={fontPath ?? ''}>
            <span className="font-mono">{fontPath ?? '—'}</span>
          </DefinitionRow>
        </dl>
      </Group>
    </div>
  );
}

function AboutTab() {
  const { t } = useI18n();
  const info = useEngine((state) => state.info);
  const securityItems = [
    { key: 'local', icon: 'shield' },
    { key: 'temporary', icon: 'trash' },
    { key: 'sharing', icon: 'folder' },
  ] as const;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Group title={t('settings.security')} description={t('settings.securityHint')}>
        <div className="flex min-w-0 flex-col">
          {securityItems.map(({ key, icon }) => (
            <div key={key} className="flex min-w-0 items-center gap-2.5 py-2.5">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
                <Icon name={icon} size={13} />
              </span>
              <p className="min-w-0 flex-1 truncate text-[12px] leading-5 text-muted" title={t(`settings.security.${key}`)}>
                {t(`settings.security.${key}`)}
              </p>
            </div>
          ))}
        </div>
      </Group>

      <Group title={t('settings.about')}>
        <dl className="flex min-w-0 flex-col">
          <DefinitionRow term={t('settings.author')}>pohoc</DefinitionRow>
          <DefinitionRow term={t('settings.contact')}>
            <a href="mailto:po.hoc4@gmail.com" className="text-accent hover:underline">
              po.hoc4@gmail.com
            </a>
          </DefinitionRow>
          <DefinitionRow term={t('settings.license')}>
            {t('settings.license.own')} ·{' '}
            <a href="/licenses/THIRD_PARTY_NOTICES.md" target="_blank" rel="noreferrer" className="text-accent hover:underline">
              {t('settings.license.thirdParty')}
            </a>
          </DefinitionRow>
          <DefinitionRow term={t('settings.version')}>
            <span className="font-mono">app {APP_VERSION} · engine {info?.version ?? '—'}</span>
          </DefinitionRow>
          <DefinitionRow term={t('settings.runMode')}>
            {transportMode() === 'tauri' ? t('settings.engineMode.tauri') : t('settings.engineMode.web')}
          </DefinitionRow>
        </dl>
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 py-3">
          <span className="text-[11px] leading-4 text-faint">{t('settings.copyright')}</span>
          <ResetDialog />
        </div>
      </Group>
    </div>
  );
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
