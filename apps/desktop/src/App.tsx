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

export function App() {
  const boot = useEngine((state) => state.boot);
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
