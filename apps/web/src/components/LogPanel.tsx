import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Rnd } from 'react-rnd';
import { clearLog, exportLog, logEntries, subscribeLog, type LogLevel } from '../lib/log-buffer.ts';
import { translate } from '../i18n/index.tsx';
import { isTauri, nativeSaveAs } from '../lib/tauri.ts';

const LEVELS: Array<LogLevel | 'all'> = ['all', 'info', 'warn', 'error'];
const LEVEL_TONE: Record<LogLevel, string> = {
  debug: 'text-muted',
  info: 'text-ink',
  warn: 'text-warn',
  error: 'text-bad',
};

const PANEL_MIN_WIDTH = 320;
const PANEL_MIN_HEIGHT = 180;
const PANEL_DEFAULT_WIDTH = 608;
const PANEL_DEFAULT_HEIGHT = 432;

/** Bottom-right of the viewport, above the reopen badge. */
function panelDefault() {
  return {
    x: Math.max(12, window.innerWidth - PANEL_DEFAULT_WIDTH - 12),
    y: Math.max(12, window.innerHeight - PANEL_DEFAULT_HEIGHT - 48),
    width: Math.min(PANEL_DEFAULT_WIDTH, window.innerWidth - 24),
    height: Math.min(PANEL_DEFAULT_HEIGHT, window.innerHeight - 60),
  };
}

function timeOf(at: number): string {
  const date = new Date(at);
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/**
 * Log panel: the packaged app has no devtools, so this is the only way to get a
 * failure's surrounding context out of an installed build. Toggled with
 * Cmd/Ctrl+Shift+D, or the badge in the corner. The open panel floats over the
 * app; `react-rnd` (the standard react-draggable + re-resizable pairing)
 * provides header-dragged moving and corner resizing with viewport bounds.
 *
 * Uses the imperative `translate` so it can be mounted outside the provider tree
 * and still follow the selected language.
 */
export function LogPanel() {
  const entries = useSyncExternalStore(subscribeLog, logEntries);
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState<LogLevel | 'all'>('all');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const errors = entries.filter((entry) => entry.level === 'error').length;
  const filtered = level === 'all' ? entries : entries.filter((entry) => entry.level === level);
  // Bound the work per render: a pathological burst should not make the panel
  // itself the slowest thing on screen.
  const shown = filtered.length > 200 ? filtered.slice(-200) : filtered;

  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(exportLog()).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  }, []);

  const save = useCallback(() => {
    const bytes = new TextEncoder().encode(exportLog());
    if (isTauri()) {
      void nativeSaveAs('potools-logs.txt', bytes);
      return;
    }
    const blob = new Blob([bytes], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `potools-logs-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.txt`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
  }, []);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={translate('log.open')}
        className="fixed bottom-3 right-3 z-[80] flex h-7 items-center gap-1.5 rounded-pill border border-control-line bg-surface px-2.5 text-[11px] text-muted shadow-pop hover:text-ink"
      >
        {translate('log.title')}
        {errors ? <span className="font-mono text-bad">{errors}</span> : null}
      </button>
    );
  }

  return (
    <Rnd
      default={panelDefault()}
      dragHandleClassName="log-panel-drag-handle"
      cancel="button"
      bounds="window"
      minWidth={PANEL_MIN_WIDTH}
      minHeight={PANEL_MIN_HEIGHT}
      enableUserSelectHack={false}
      resizeHandleStyles={{
        bottomRight: { width: 14, height: 14, cursor: 'nwse-resize' },
        right: { width: 6, cursor: 'ew-resize' },
        bottom: { height: 6, cursor: 'ns-resize' },
      }}
      className="z-[80]"
    >
      <section
        aria-label={translate('log.title')}
        className="flex h-full w-full flex-col overflow-hidden rounded-control border border-line bg-surface text-ink shadow-pop"
      >
        <header className="log-panel-drag-handle flex shrink-0 cursor-grab items-center gap-2 border-b border-line px-3 py-2 active:cursor-grabbing">
          <strong className="text-[12.5px]">{translate('log.title')}</strong>
          <span className="text-[11px] text-muted">{translate('log.count').replace('{count}', String(entries.length))}</span>
          <div className="ml-2 flex items-center gap-1">
            {LEVELS.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setLevel(item)}
                aria-pressed={level === item}
                className={`h-6 rounded-control border px-2 text-[11px] ${
                  level === item ? 'border-control-line bg-raised text-ink' : 'border-transparent text-muted hover:text-ink'
                }`}
              >
                {item === 'all' ? translate('log.all') : item}
              </button>
            ))}
          </div>
          <span className="flex-1" />
          <button type="button" onClick={copy} className="h-6 rounded-control border border-control-line px-2 text-[11px] text-muted hover:text-ink">
            {copied ? translate('log.copied') : translate('log.copy')}
          </button>
          <button
            type="button"
            onClick={save}
            title={translate('log.saveHint')}
            className="h-6 rounded-control border border-control-line px-2 text-[11px] text-muted hover:text-ink"
          >
            {translate('log.save')}
          </button>
          <button type="button" onClick={clearLog} className="h-6 rounded-control border border-control-line px-2 text-[11px] text-muted hover:text-ink">
            {translate('log.clear')}
          </button>
          <button type="button" onClick={() => setOpen(false)} className="h-6 rounded-control border border-control-line px-2 text-[11px] text-muted hover:text-ink">
            {translate('log.close')}
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-[11px] leading-5">
          {shown.length === 0 ? (
            <p className="text-muted">{translate('log.empty')}</p>
          ) : (
            shown.map((entry) => (
              <div key={entry.seq} className="whitespace-pre-wrap break-words">
                <span className="text-faint">{timeOf(entry.at)} </span>
                <span className={LEVEL_TONE[entry.level]}>{entry.text}</span>
                {entry.detail ? (
                  // Stacks are truncated for display: hundreds of full traces in the
                  // DOM is megabytes of text and can hang the renderer on its own.
                  <span className="block pl-16 text-faint" title={entry.detail}>
                    {entry.detail.split('\n').slice(0, 3).join('\n')}
                  </span>
                ) : null}
              </div>
            ))
          )}
        </div>
      </section>
    </Rnd>
  );
}
