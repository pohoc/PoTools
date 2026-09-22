import React from 'react';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from '@potools/ui';
import { HashRouter } from 'react-router-dom';
import { App } from './App.tsx';
import { I18nProvider } from './i18n/index.tsx';
import { bootstrapSettings, useSettings } from './lib/settings.ts';
import './styles.css';

class ErrorReportBoundary extends Component<{ children: ReactNode }, { error: Error | null; copied: boolean }> {
  state = { error: null as Error | null, copied: false };
  static getDerivedStateFromError(error: Error) { return { error }; }
  private onWindowError = (event: ErrorEvent) => this.setState({ error: event.error instanceof Error ? event.error : new Error(event.message || 'Unknown runtime error'), copied: false });
  private onUnhandledRejection = (event: PromiseRejectionEvent) => this.setState({ error: event.reason instanceof Error ? event.reason : new Error('Unhandled asynchronous error'), copied: false });
  componentDidMount() { window.addEventListener('error', this.onWindowError); window.addEventListener('unhandledrejection', this.onUnhandledRejection); }
  componentWillUnmount() { window.removeEventListener('error', this.onWindowError); window.removeEventListener('unhandledrejection', this.onUnhandledRejection); }
  componentDidCatch(error: Error, _info: ErrorInfo) { console.error('PoTools UI error', error.name, error.message); }
  render() {
    if (!this.state.error) return this.props.children;
    const report = safeErrorReport(this.state.error);
    return <main className="mx-auto mt-12 max-w-2xl rounded-card border border-line bg-surface p-6 text-ink"><h1 className="text-lg font-semibold">应用遇到问题</h1><p className="mt-2 text-sm text-muted">错误报告已去除本机路径。报告不包含所选文件或图片内容。</p><pre className="mt-4 max-h-64 overflow-auto whitespace-pre-wrap rounded-control bg-canvas p-3 text-xs">{report}</pre><div className="mt-4 flex gap-2"><Button variant="primary" size="sm" onClick={() => void navigator.clipboard.writeText(report).then(() => this.setState({ copied: true }))}>{this.state.copied ? '已复制' : '复制错误报告'}</Button><Button variant="quiet" size="sm" onClick={() => this.setState({ error: null, copied: false })}>重新显示应用</Button></div></main>;
  }
}

function safeErrorReport(error: Error) {
  const redact = (text: string) => text
    .replace(/(?:\/Users\/|\/home\/|[A-Z]:\\)[^\s"']+/g, '[本机路径]')
    .replace(/(?:data:image\/[^;]+;base64,)[A-Za-z0-9+/=]+/g, '[图片数据已省略]')
    .replace(/(?:[A-Za-z]:\\\\|\/)[^\s]+\.(?:jpg|jpeg|png|webp|tiff|pdf)/gi, '[文件路径]');
  return redact(`PoTools UI error\nName: ${error.name}\nMessage: ${error.message}\nStack:\n${error.stack ?? '(unavailable)'}`);
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
