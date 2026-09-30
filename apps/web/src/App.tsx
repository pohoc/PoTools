import { lazy, Suspense, useEffect, useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell.tsx';
import { AppLogo } from './components/AppLogo.tsx';
import { Button, Icon, ThemeProvider, Toaster } from '@potools/ui';
import { useEngine } from './stores/engine.ts';
import { useJobs } from './stores/jobs.ts';
import { useI18n } from './i18n/index.tsx';
import { useSettings } from './lib/settings.ts';
import { TitleBar } from './components/TitleBar.tsx';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './lib/tauri.ts';
import { isMac } from './lib/window.ts';
import { clearThumbCache } from './lib/usePageThumbs.ts';
import { LicenseAgreement } from './components/LicenseAgreement.tsx';

// One chunk per route: the landing page should not wait on the settings screen,
// the queue, or the tool workspace (which itself splits its heavy panels).
const Home = lazy(() => import('./pages/Home.tsx').then((module) => ({ default: module.Home })));
const ToolPage = lazy(() => import('./pages/ToolPage.tsx').then((module) => ({ default: module.ToolPage })));
const QueuePage = lazy(() => import('./pages/QueuePage.tsx').then((module) => ({ default: module.QueuePage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage.tsx').then((module) => ({ default: module.SettingsPage })));

const MAC_LICENSE_ACCEPTANCE_KEY = 'potools.license.accepted.v1';

function hasAcceptedMacLicense(): boolean {
  if (!isMac()) return true;
  try {
    return localStorage.getItem(MAC_LICENSE_ACCEPTANCE_KEY) === 'accepted';
  } catch {
    return false;
  }
}

export function App() {
  const theme = useSettings((state) => state.theme);
  const [licenseAccepted, setLicenseAccepted] = useState(hasAcceptedMacLicense);

  const acceptLicense = () => {
    try {
      localStorage.setItem(MAC_LICENSE_ACCEPTANCE_KEY, 'accepted');
    } catch {
      // Keep this launch usable if the webview storage is unavailable.
    }
    setLicenseAccepted(true);
  };

  const declineLicense = () => {
    void invoke('exit_app').catch(() => getCurrentWindow().close());
  };

  return (
    <ThemeProvider mode={theme} onModeChange={(mode) => useSettings.getState().set('theme', mode)}>
      {licenseAccepted
        ? <MainApp />
        : <LicenseAgreement onAccept={acceptLicense} onDecline={declineLicense} />}
    </ThemeProvider>
  );
}

function MainApp() {
  const boot = useEngine((state) => state.boot);
  const reconnect = useEngine((state) => state.reconnect);
  const status = useEngine((state) => state.status);
  const reconnecting = useEngine((state) => state.reconnecting);
  const error = useEngine((state) => state.error);
  const attach = useJobs((state) => state.attach);
  const { t } = useI18n();

  useEffect(() => {
    void boot().then(() => {
      // Honour the retention preference on every launch, not only in dev.
      const ttl = useSettings.getState().tempTtlDays;
      if (ttl > 0) {
        void useEngine.getState().call('temp.clean', { olderThanDays: ttl, keepJobs: 1 }).catch(() => undefined);
      }
    });
  }, [boot]);

  // Job events and cached page renders belong to one engine instance. A manual
  // reconnect replaces the transport, so re-subscribe once it is ready again and
  // drop renders produced by the previous instance while it is down.
  useEffect(() => {
    if (status === 'ready') {
      attach();
      return;
    }
    clearThumbCache();
  }, [status, attach]);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void getCurrentWindow().onCloseRequested(async () => {
      if (disposed || !useSettings.getState().cleanupTempOnClose) return;
      const ttl = useSettings.getState().tempTtlDays;
      await useEngine.getState().call('temp.clean', { olderThanDays: ttl || 7, keepJobs: 1 }).catch(() => undefined);
    }).then((unlisten) => {
      // UnlistenFn returns void; route through a promise so a remove-listener
      // race (webview already torn down) can never surface as an unhandled
      // rejection — the crash screen turns any of those into a full error UI.
      if (disposed) void Promise.resolve().then(unlisten).catch(() => undefined);
      else stop = unlisten;
    }).catch((issue: unknown) => {
      // Registration may lose a race with native window destruction.
      console.debug('PoTools close listener unavailable', issue);
    });
    return () => {
      disposed = true;
      void Promise.resolve().then(() => stop?.()).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    document.title = t('app.name');
    // `t` is memoised on the locale's message table, so it changes exactly when
    // the language does — listing the locale as well was redundant.
  }, [t]);

  if (status !== 'ready' || reconnecting) {
    return <EngineStartupScreen error={status === 'offline' ? error : null} retry={() => void reconnect()} />;
  }

  return (
    <>
      <AppShell>
        {/* Kept inside the shell so the sidebar and title bar never unmount
            while a route chunk is being fetched. */}
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/tool/:toolId" element={<ToolPage />} />
            <Route path="/queue" element={<QueuePage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Home />} />
          </Routes>
        </Suspense>
      </AppShell>
      <Toaster />
    </>
  );
}

function RouteFallback() {
  const { t } = useI18n();
  return (
    <div className="flex flex-1 items-center justify-center py-16 text-xs text-muted" role="status" aria-live="polite">
      <Icon name="spinner" size={16} className="mr-2 animate-spin motion-reduce:animate-none" />
      {t('app.loading')}
    </div>
  );
}

function EngineStartupScreen({ error, retry }: { error: string | null; retry: () => void }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const report = error ? sanitizeStartupError(error, t('startup.pathHidden')) : '';

  const copyReport = async () => {
    await navigator.clipboard.writeText(`PoTools engine startup error\n${report}`);
    setCopied(true);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas text-ink">
      <TitleBar
        brand={<span className="flex items-center gap-2"><AppLogo className="h-[18px] w-[18px]" /><span className="text-[12.5px] font-semibold">{t('app.name')}</span></span>}
        title={t('startup.title')}
      />
      <main className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto px-6 py-10">
        <section className="relative w-full max-w-[460px]">
          <div className="mb-8 flex items-center gap-3">
            <div className="grid h-12 w-12 place-items-center rounded-2xl border border-accent/20 bg-accent-soft text-accent shadow-sm">
              {error ? <Icon name="serverCrash" size={22} /> : <Icon name="spinner" size={22} className="animate-spin motion-reduce:animate-none" />}
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[.16em] text-accent">{t('startup.localProcessing')}</p>
              <p className="mt-1 text-xs text-muted">{error ? t('startup.failed') : t('startup.connecting')}</p>
            </div>
          </div>
          <h1 className="text-[25px] font-semibold tracking-[-.035em]">{error ? t('startup.failedTitle') : t('startup.title')}</h1>
          <p className="mt-3 max-w-[390px] text-[13px] leading-6 text-muted">
            {error ? t('startup.failedHint') : t('startup.hint')}
          </p>
          {error ? (
            <>
              <pre className="mt-6 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-line bg-surface/80 p-4 font-mono text-[11px] leading-5 text-muted">{report}</pre>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button onClick={retry}><Icon name="reset" size={14} />{t('startup.retry')}</Button>
                <Button variant="secondary" onClick={() => void copyReport()}>{copied ? <Icon name="check" size={14} /> : <Icon name="clipboard" size={14} />}{copied ? t('startup.copied') : t('startup.copy')}</Button>
              </div>
              <p className="mt-4 text-[11px] leading-5 text-muted">{t('startup.privacy')}</p>
            </>
          ) : (
            <div className="mt-7 flex items-center gap-2 text-xs text-muted" role="status" aria-live="polite">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent motion-reduce:animate-none" />
              {t('startup.waiting')}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function sanitizeStartupError(error: string, pathHidden: string): string {
  return error
    .replace(/(?:[A-Z]:\\|\\\\)[^\r\n"']+/g, pathHidden)
    .replace(/(?:\/Users\/|\/home\/)[^\r\n"']+/g, pathHidden)
    .slice(0, 5000);
}
