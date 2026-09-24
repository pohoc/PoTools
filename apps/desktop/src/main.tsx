import React from 'react';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from '@potools/ui';
import { HashRouter } from 'react-router-dom';
import { App } from './App.tsx';
import { I18nProvider } from './i18n/index.tsx';
import { bootstrapSettings, useSettings } from './lib/settings.ts';
import { en } from './i18n/en.ts';
import { zhCN, type Messages } from './i18n/zh-CN.ts';
import './styles.css';

class ErrorReportBoundary extends Component<{ children: ReactNode }, { error: Error | null; copied: boolean }> {
  state = { error: null as Error | null, copied: false };
  static getDerivedStateFromError(error: Error) { return { error }; }
  private onWindowError = (event: ErrorEvent) => this.setState({ error: event.error instanceof Error ? event.error : new Error(event.message || 'Unknown runtime error'), copied: false });
  private onUnhandledRejection = (event: PromiseRejectionEvent) => this.setState({ error: rejectionToError(event.reason), copied: false });
  componentDidMount() { window.addEventListener('error', this.onWindowError); window.addEventListener('unhandledrejection', this.onUnhandledRejection); }
  componentWillUnmount() { window.removeEventListener('error', this.onWindowError); window.removeEventListener('unhandledrejection', this.onUnhandledRejection); }
  componentDidCatch(error: Error, _info: ErrorInfo) { console.error('PoTools UI error', error.name, error.message); }
  render() {
    if (!this.state.error) return this.props.children;
    const messages: Messages = useSettings.getState().locale === 'en' ? en : zhCN;
    const report = safeErrorReport(this.state.error, messages);
    return (
      <main className="mx-auto mt-12 max-w-2xl rounded-card border border-line bg-surface p-6 text-ink">
        <h1 className="text-lg font-semibold">{messages['app.crash.title']}</h1>
        <p className="mt-2 text-sm text-muted">{messages['app.crash.description']}</p>
        <pre className="mt-4 max-h-64 overflow-auto whitespace-pre-wrap rounded-control bg-canvas p-3 text-xs">{report}</pre>
        <div className="mt-4 flex gap-2">
          <Button variant="primary" size="sm" onClick={() => void navigator.clipboard.writeText(report).then(() => this.setState({ copied: true }))}>
            {this.state.copied ? messages['app.crash.copied'] : messages['app.crash.copy']}
          </Button>
          <Button variant="quiet" size="sm" onClick={() => this.setState({ error: null, copied: false })}>{messages['app.crash.reload']}</Button>
        </div>
      </main>
    );
  }
}

function safeErrorReport(error: Error, messages: Messages) {
  const redact = (text: string) => text
    .replace(/(?:\/Users\/|\/home\/|[A-Z]:\\)[^\s"']+/g, messages['app.crash.pathHidden'])
    .replace(/(?:data:image\/[^;]+;base64,)[A-Za-z0-9+/=]+/g, messages['app.crash.imageOmitted'])
    .replace(/(?:[A-Za-z]:\\\\|\/)[^\s]+\.(?:jpg|jpeg|png|webp|tiff|pdf)/gi, messages['app.crash.filePath']);
  return redact(`PoTools UI error\nName: ${error.name}\nMessage: ${error.message}\nStack:\n${error.stack ?? '(unavailable)'}`);
}

function rejectionToError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  if (typeof reason === 'string') return new Error(reason);
  if (reason && typeof reason === 'object') {
    const value = reason as { name?: unknown; message?: unknown; stack?: unknown };
    const error = new Error(
      typeof value.message === 'string' && value.message
        ? value.message
        : safeStringify(reason),
    );
    if (typeof value.name === 'string' && value.name) error.name = value.name;
    if (typeof value.stack === 'string' && value.stack) error.stack = value.stack;
    return error;
  }
  return new Error(String(reason));
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

const initial = bootstrapSettings();
// Pre-mount mirror of the stored theme so the first paint already has the
// right class; ThemeProvider (controlled by the settings store) takes over
// once React mounts.
document.documentElement.classList.toggle(
  'dark',
  initial.theme === 'dark' ||
    (initial.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches),
);
document.documentElement.lang = initial.locale === 'en' ? 'en' : 'zh-CN';

/** Subscribes to the store so a locale change re-renders every translated node. */
function Root() {
  const locale = useSettings((state) => state.locale);
  return (
    <I18nProvider locale={locale}>
      <HashRouter>
        <App />
      </HashRouter>
    </I18nProvider>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode><ErrorReportBoundary>
    <Root />
  </ErrorReportBoundary></React.StrictMode>,
);
