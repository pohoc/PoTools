import { useEffect, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { Monitor, Moon, Sun } from 'lucide-react';
import { Icon } from './Icon.tsx';
import { TitleBar } from './TitleBar.tsx';
import { Badge } from './ui/badge.tsx';
import { Button } from './ui/button.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip.tsx';
import { useI18n } from '../i18n/index.tsx';
import { applyTheme, useSettings } from '../lib/settings.ts';
import { transportMode, useEngine } from '../stores/engine.ts';
import { useJobs } from '../stores/jobs.ts';
import { useMediaQuery } from '../lib/useMediaQuery.ts';
import { cn } from '../lib/utils.ts';
import { TOOLS, type ToolId } from 'core';

const NAV = [
  { to: '/', key: 'nav.tools', icon: 'layout-grid', end: true },
  { to: '/queue', key: 'nav.queue', icon: 'queue' },
];

function rowClass(rail: boolean, isActive: boolean) {
  return cn(
    'relative flex h-10 items-center gap-3 rounded-control px-3 text-[12.5px] transition-colors',
    rail && 'justify-center px-0',
    isActive ? 'bg-accent-soft font-medium text-accent' : 'text-muted hover:bg-raised hover:text-ink',
  );
}

const THEMES = [
  { value: 'system', icon: Monitor },
  { value: 'light', icon: Sun },
  { value: 'dark', icon: Moon },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const settings = useSettings();
  const location = useLocation();
  const status = useEngine((state) => state.status);
  const running = useJobs((state) => state.jobs.filter((job) => job.progress.state === 'running').length);
  const narrow = useMediaQuery('(max-width: 1080px)');
  const rail = settings.sidebarCollapsed || narrow;
  const on = (to: string, end = false) => (end ? location.pathname === to : location.pathname.startsWith(to));

  useEffect(() => {
    applyTheme(settings.theme);
  }, [settings.theme]);

  useEffect(() => {
    document.documentElement.lang = settings.locale === 'en' ? 'en' : 'zh-CN';
  }, [settings.locale]);

  const tone = status === 'ready' ? 'bg-ok' : status === 'connecting' ? 'bg-warn' : 'bg-bad';
  const statusLabel =
    status === 'ready' ? t('engine.ready') : status === 'connecting' ? t('engine.connecting') : t('engine.offline');

  const toolMatch = /^\/tool\/([\w-]+)$/.exec(location.pathname);
  const pageTitle = toolMatch
    ? t(TOOLS[toolMatch[1] as ToolId]?.nameKey ?? 'app.name')
    : location.pathname.startsWith('/queue')
      ? t('nav.queue')
      : location.pathname.startsWith('/settings')
        ? t('nav.settings')
        : t('nav.tools');

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-canvas">
      <TitleBar
        brand={
          <span className="flex items-center gap-2">
            <img src="/app-icon.svg" alt="" draggable={false} className="h-[18px] w-[18px] shrink-0 select-none" />
            <span className="truncate text-[12.5px] font-semibold tracking-tight text-ink">{t('app.name')}</span>
          </span>
        }
        title={pageTitle}
        actions={
          <>
            <Tooltip delayDuration={300}>
              <TooltipTrigger asChild>
                <Link
                  to="/settings?tab=engine"
                  aria-label={`${t('settings.engineStatus')}: ${statusLabel}`}
                  className="flex h-8 items-center gap-2 rounded-control px-2 text-[11px] text-muted transition hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <span className={cn('h-2 w-2 shrink-0 rounded-full', tone)} />
                  <span className="hidden sm:inline">{statusLabel}</span>
                </Link>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t('settings.engineStatus')}: {statusLabel}</TooltipContent>
            </Tooltip>
            <Badge variant="outline" className="mr-1 hidden md:inline-flex">
              {transportMode() === 'tauri' ? t('engine.mode.tauri') : t('engine.mode.web')}
            </Badge>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={t('settings.language')}>
                  <Icon name="globe" size={15} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-[10rem]">
                <DropdownMenuLabel>{t('settings.language')}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuRadioGroup
                  value={settings.locale}
                  onValueChange={(value) => settings.set('locale', value as 'zh-CN' | 'en')}
                >
                  <DropdownMenuRadioItem value="zh-CN">简体中文</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="en">English</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`${t('settings.theme')}: ${t(`settings.theme.${settings.theme}`)}`}
                >
                  <Icon name={settings.theme === 'dark' ? 'moon' : settings.theme === 'light' ? 'sun' : 'monitor'} size={15} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-[11rem]">
                <DropdownMenuLabel>{t('settings.theme')}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuRadioGroup value={settings.theme} onValueChange={(value) => settings.set('theme', value as 'system')}>
                  {THEMES.map((option) => (
                    <DropdownMenuRadioItem key={option.value} value={option.value}>
                      <option.icon size={13} />
                      {t(`settings.theme.${option.value}`)}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      <div className="flex min-h-0 flex-1">
        <aside
          className={cn(
            'flex shrink-0 flex-col border-r border-line bg-surface transition-[width] duration-150',
            rail ? 'w-14' : 'w-sidebar',
          )}
        >
          <nav className="flex flex-1 flex-col gap-1 px-2.5 py-3" aria-label={t('nav.tools')}>
            {!rail ? <p className="px-2 pb-1 pt-1 text-[9.5px] font-semibold uppercase tracking-[.16em] text-faint">{t('sidebar.workspace')}</p> : null}
            {NAV.map((item) => (
              <Tooltip key={item.to} delayDuration={400}>
                <TooltipTrigger asChild>
                  <NavLink to={item.to} end={item.end} className={rowClass(rail, on(item.to, item.end))}>
                    <Icon name={item.icon} size={17} className="shrink-0" />
                    {!rail ? <span className="truncate">{t(item.key)}</span> : null}
                    {item.to === '/queue' && running ? (
                      <span
                        className={cn(
                          'shrink-0 rounded-full bg-accent px-1.5 text-[10.5px] font-semibold leading-4 text-accent-ink',
                          rail ? 'absolute right-1 top-1' : 'ml-auto',
                        )}
                      >
                        {running}
                      </span>
                    ) : null}
                  </NavLink>
                </TooltipTrigger>
                {rail ? <TooltipContent side="right">{t(item.key)}</TooltipContent> : null}
              </Tooltip>
            ))}
          </nav>

          <div className="border-t border-line px-2.5 py-3">
            {!rail ? <p className="px-2 pb-2 pt-0.5 text-[9.5px] font-semibold uppercase tracking-[.16em] text-faint">{t('sidebar.system')}</p> : null}
            <div className="flex flex-col gap-1">
              <Tooltip delayDuration={400}>
                <TooltipTrigger asChild>
                  <NavLink to="/settings" className={rowClass(rail, on('/settings'))}>
                    <Icon name="settings" size={16} className="shrink-0" />
                    {!rail ? <span className="truncate">{t('nav.settings')}</span> : null}
                  </NavLink>
                </TooltipTrigger>
                {rail ? <TooltipContent side="right">{t('nav.settings')}</TooltipContent> : null}
              </Tooltip>
              {!narrow ? (
                <Button
                  variant="ghost"
                  size="default"
                  type="button"
                  onClick={() => settings.set('sidebarCollapsed', !settings.sidebarCollapsed)}
                  className={cn(
                    'h-9 justify-start gap-3 border-transparent bg-transparent text-[11.5px] text-muted hover:bg-raised hover:text-ink',
                    rail ? 'justify-center px-0' : 'px-3',
                  )}
                  title={rail ? t('nav.expand') : t('nav.collapse')}
                  aria-label={rail ? t('nav.expand') : t('nav.collapse')}
                >
                  <Icon name="sidebar" size={16} />
                  {!rail ? <span>{t('nav.collapse')}</span> : null}
                </Button>
              ) : null}
              {!rail ? (
                <a
                  href="mailto:po.hoc4@gmail.com"
                  title={`${t('settings.copyright')} · pohoc <po.hoc4@gmail.com>`}
                  className="truncate px-3 py-1 text-[10px] leading-4 text-faint transition hover:text-muted"
                >
                  {t('settings.copyrightShort')}
                </a>
              ) : null}
            </div>
          </div>
        </aside>

        <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5 sm:py-5">{children}</main>
      </div>
    </div>
  );
}
