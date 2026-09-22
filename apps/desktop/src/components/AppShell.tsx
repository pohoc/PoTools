import { useEffect, type ComponentProps, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { Badge, Button, cn, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, Icon, Tooltip, TooltipContent, TooltipTrigger } from '@potools/ui';
import { TitleBar } from './TitleBar.tsx';
import { Status } from './Status.tsx';
import { useI18n } from '../i18n/index.tsx';
import { useSettings } from '../lib/settings.ts';
import { transportMode, useEngine } from '../stores/engine.ts';
import { useJobs } from '../stores/jobs.ts';
import { useMediaQuery } from '../lib/useMediaQuery.ts';
import { rowClass } from '../lib/rows.ts';
import { TOOLS, type ToolId } from 'core';
import { APP_VERSION } from '../lib/version.ts';

const NAV = [
  { to: '/', key: 'nav.tools', icon: 'layout-grid', end: true },
  { to: '/queue', key: 'nav.queue', icon: 'queue' },
];

/**
 * HeroUI v3's Tooltip.Trigger has no `asChild` — it always mounts a `div[role=button]`,
 * which would add a nameless second tab stop per row. `render` projects the trigger
 * props onto the row element instead, so a row stays one focusable control.
 */
function RailTip({
  rail,
  label,
  children,
}: {
  rail: boolean;
  label: string;
  children: (trigger: object) => ReactNode;
}) {
  if (!rail) return <>{children({})}</>;
  return (
    <Tooltip delayDuration={400}>
      <TooltipTrigger
        render={(props) => {
          const { className: _className, role: _role, children: _children, ...trigger } = props;
          return <>{children(trigger)}</>;
        }}
      />
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

function NavRow({
  to,
  end,
  label,
  icon,
  iconSize = 17,
  rail,
  active,
  children,
}: {
  to: string;
  end?: boolean;
  label: string;
  icon: string;
  iconSize?: number;
  rail: boolean;
  active: boolean;
  children?: ReactNode;
}) {
  return (
    <RailTip rail={rail} label={label}>
      {(trigger) => (
        <NavLink
          {...(trigger as ComponentProps<typeof NavLink>)}
          to={to}
          end={end}
          aria-label={rail ? label : undefined}
          className={rowClass({ rail, active })}
        >
          <Icon name={icon} size={iconSize} className="shrink-0" />
          {!rail ? <span className="truncate">{label}</span> : null}
          {children}
        </NavLink>
      )}
    </RailTip>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const settings = useSettings();
  const location = useLocation();
  const status = useEngine((state) => state.status);
  const running = useJobs((state) => state.jobs.filter((job) => job.progress.state === 'running').length);
  const narrow = useMediaQuery('(max-width: 1080px)');
  const compact = useMediaQuery('(max-width: 760px)');
  // Keep labels available in the compact top navigation. The rail is useful
  // in a medium desktop window, but icon-only navigation is too ambiguous at
  // the smallest supported window size.
  const rail = !compact && (settings.sidebarCollapsed || narrow);
  /** CJK labels read badly with the Latin uppercase + wide tracking treatment. */
  const sectionLabel = (spacing: string) =>
    cn(
      'px-3 font-semibold text-faint',
      settings.locale === 'en' ? 'text-[9.5px] uppercase tracking-[.16em]' : 'text-[11px] tracking-[.02em]',
      spacing,
    );
  const on = (to: string, end = false) => (end ? location.pathname === to : location.pathname.startsWith(to));

  useEffect(() => {
    document.documentElement.lang = settings.locale === 'en' ? 'en' : 'zh-CN';
  }, [settings.locale]);

  const statusColor = status === 'ready' ? 'var(--ui-ok)' : status === 'connecting' ? 'var(--ui-warn)' : 'var(--ui-bad)';
  const statusLabel = status === 'ready' ? t('engine.ready') : t('engine.offline');
  const nextTheme = settings.theme === 'system' ? 'light' : settings.theme === 'light' ? 'dark' : 'system';

  const toolMatch = /^\/tool\/([\w-]+)$/.exec(location.pathname);
  const pageTitle = toolMatch
    ? t(TOOLS[toolMatch[1] as ToolId]?.nameKey ?? 'app.name')
    : location.pathname.startsWith('/queue')
      ? t('nav.queue')
      : location.pathname.startsWith('/settings')
        ? t('nav.settings')
        : t('nav.tools');

  return (
    <div className="app-shell flex h-full w-full flex-col overflow-hidden bg-canvas">
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
            <Link
              to="/settings?tab=engine"
              aria-label={`${t('settings.engineStatus')}: ${statusLabel}`}
              title={`${t('settings.engineStatus')}: ${statusLabel}`}
              className="mr-1 flex h-8 items-center gap-2 rounded-control px-2 text-[11px] text-muted transition hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <Status color={`rgb(${statusColor})`} active={status !== 'offline'} label={statusLabel} />
              <span className="titlebar-status-label">{statusLabel}</span>
            </Link>
            <Badge variant="outline" className="mr-1 hidden md:inline-flex">
              {transportMode() === 'tauri' ? t('engine.mode.tauri') : t('engine.mode.web')}
            </Badge>
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={t('settings.language')}
                className="inline-flex h-8 w-8 items-center justify-center rounded-control text-muted transition hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/35"
              >
                <Icon name="globe" size={15} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-[10rem]">
                <DropdownMenuLabel>{t('settings.language')}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onAction={() => settings.set('locale', 'zh-CN')}>
                  {settings.locale === 'zh-CN' ? '✓ ' : ''}简体中文
                </DropdownMenuItem>
                <DropdownMenuItem onAction={() => settings.set('locale', 'en')}>
                  {settings.locale === 'en' ? '✓ ' : ''}English
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <button
              type="button"
              onClick={() => settings.set('theme', nextTheme)}
              aria-label={`${t('settings.theme')}: ${t(`settings.theme.${settings.theme}`)}`}
              title={`${t('settings.theme')}: ${t(`settings.theme.${settings.theme}`)}`}
              className="inline-flex h-8 w-8 items-center justify-center rounded-control text-muted transition hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/35"
            >
              <Icon name={settings.theme === 'dark' ? 'moon' : settings.theme === 'light' ? 'sun' : 'monitor'} size={15} />
            </button>
          </>
        }
      />

      <div className="flex min-h-0 flex-1">
        <aside
          className={cn(
            'app-sidebar flex shrink-0 flex-col border-r border-line bg-surface transition-[width] duration-150',
            rail ? 'w-14' : 'w-sidebar',
          )}
        >
          <nav className="flex flex-1 flex-col gap-1 px-2.5 py-3" aria-label={t('nav.tools')}>
            {!rail ? <p className={sectionLabel('pb-1 pt-1')}>{t('sidebar.workspace')}</p> : null}
            {NAV.map((item) => (
              <NavRow
                key={item.to}
                to={item.to}
                end={item.end}
                rail={rail}
                active={on(item.to, item.end)}
                label={t(item.key)}
                icon={item.icon}
              >
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
              </NavRow>
            ))}
          </nav>

          <div className="border-t border-line px-2.5 py-3">
            {!rail ? <p className={sectionLabel('pb-2 pt-0.5')}>{t('sidebar.system')}</p> : null}
            <div className="flex flex-col gap-1">
              <NavRow
                to="/settings"
                rail={rail}
                active={on('/settings')}
                label={t('nav.settings')}
                icon="settings"
                iconSize={16}
              />
              {!narrow ? (
                <RailTip rail={rail} label={rail ? t('nav.expand') : t('nav.collapse')}>
                  {(trigger) => (
                    <button
                      {...(trigger as ComponentProps<'button'>)}
                      type="button"
                      onClick={() => settings.set('sidebarCollapsed', !settings.sidebarCollapsed)}
                      aria-expanded={!rail}
                      aria-label={rail ? t('nav.expand') : undefined}
                      className={rowClass({ rail })}
                    >
                      <Icon name="sidebar" size={16} className="shrink-0" />
                      {!rail ? <span className="truncate">{t('nav.collapse')}</span> : null}
                    </button>
                  )}
                </RailTip>
              ) : null}
              {!rail ? (
                <div className="px-3 pt-2 text-center">
                  <a
                    href="mailto:po.hoc4@gmail.com"
                    className="sidebar-copyright inline-block text-[10px] leading-4 text-faint transition hover:text-muted"
                    title={`${t('settings.copyright')} · pohoc <po.hoc4@gmail.com>`}
                  >
                    v{APP_VERSION} · MIT · pohoc
                  </a>
                </div>
              ) : null}
            </div>
          </div>
        </aside>

        <main className="app-main min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-6 sm:py-6">{children}</main>
      </div>
    </div>
  );
}
