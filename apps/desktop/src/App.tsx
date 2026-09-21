import { useEffect } from 'react';
import { Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell.tsx';
import { TooltipProvider } from './components/ui/tooltip.tsx';
import { Toaster } from './components/ui/sonner.tsx';
import { Home } from './pages/Home.tsx';
import { ToolPage } from './pages/ToolPage.tsx';
import { QueuePage } from './pages/QueuePage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { useEngine } from './stores/engine.ts';
import { useJobs } from './stores/jobs.ts';
import { useI18n } from './i18n/index.tsx';
import { useSettings } from './lib/settings.ts';
import { Button } from './components/ui/button.tsx';
import { TitleBar } from './components/TitleBar.tsx';
import { Check, Clipboard, LoaderCircle, RotateCcw, ServerCrash } from 'lucide-react';
import { useState } from 'react';

export function App() {
  const boot = useEngine((state) => state.boot);
  const reconnect = useEngine((state) => state.reconnect);
  const status = useEngine((state) => state.status);
  const error = useEngine((state) => state.error);
  const attach = useJobs((state) => state.attach);
  const locale = useSettings((state) => state.locale);
  const { t } = useI18n();

  useEffect(() => {
    void boot()
      .then(() => attach())
      .then(() => {
        // Honour the retention preference on every launch, not only in dev.
        const ttl = useSettings.getState().tempTtlDays;
        if (ttl > 0) {
          void useEngine.getState().call('temp.clean', { olderThanDays: ttl, keepJobs: 1 }).catch(() => undefined);
        }
      });
  }, [boot, attach]);

  useEffect(() => {
    document.title = t('app.name');
  }, [locale, t]);

  if (status !== 'ready') {
    return <EngineStartupScreen error={status === 'offline' ? error : null} retry={() => void reconnect()} />;
  }

  return (
    <TooltipProvider delayDuration={250}>
      <AppShell>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/tool/:toolId" element={<ToolPage />} />
          <Route path="/queue" element={<QueuePage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Home />} />
        </Routes>
      </AppShell>
      <Toaster />
    </TooltipProvider>
  );
}

function EngineStartupScreen({ error, retry }: { error: string | null; retry: () => void }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const report = error ? sanitizeStartupError(error) : '';

  const copyReport = async () => {
    await navigator.clipboard.writeText(`PoTools engine startup error\n${report}`);
    setCopied(true);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas text-ink">
      <TitleBar
        brand={<span className="flex items-center gap-2"><img src="/app-icon.svg" alt="" className="h-[18px] w-[18px]" /><span className="text-[12.5px] font-semibold">{t('app.name')}</span></span>}
        title={t('startup.title')}
      />
      <main className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto px-6 py-10">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-60 [background-image:radial-gradient(ellipse_at_52%_42%,rgb(var(--c-accent)/.09),transparent_46%)]" />
        <section className="relative w-full max-w-[460px]">
          <div className="mb-8 flex items-center gap-3">
            <div className="grid h-12 w-12 place-items-center rounded-2xl border border-accent/20 bg-accent-soft text-accent shadow-sm">
              {error ? <ServerCrash size={22} /> : <LoaderCircle size={22} className="animate-spin motion-reduce:animate-none" />}
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[.16em] text-accent">PoTools · Local processing</p>
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
                <Button onClick={retry}><RotateCcw size={14} />{t('startup.retry')}</Button>
                <Button variant="secondary" onClick={() => void copyReport()}>{copied ? <Check size={14} /> : <Clipboard size={14} />}{copied ? t('startup.copied') : t('startup.copy')}</Button>
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

function sanitizeStartupError(error: string): string {
  return error
    .replace(/(?:[A-Z]:\\|\\\\)[^\r\n"']+/g, '[本机路径已隐藏]')
    .replace(/(?:\/Users\/|\/home\/)[^\r\n"']+/g, '[本机路径已隐藏]')
    .slice(0, 5000);
}
