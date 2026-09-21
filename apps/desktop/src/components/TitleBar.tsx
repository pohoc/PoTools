import { useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Maximize2, Minimize2, Minus, X } from 'lucide-react';
import { useI18n } from '../i18n/index.tsx';
import { Button } from './ui/button.tsx';
import { cn } from '../lib/utils.ts';
import { isTauri } from '../lib/tauri.ts';
import { closeWindow, isMac, minimizeWindow, startWindowDrag, toggleMaximize, usesCustomWindowButtons, watchMaximized } from '../lib/window.ts';

/**
 * Window chrome drawn by the app: the whole bar is a drag region, and on
 * Windows/Linux the caption buttons live inside it. macOS keeps its native
 * traffic lights, which float over the left inset declared here.
 */
export function TitleBar({
  brand,
  title,
  actions,
  className,
}: {
  brand: React.ReactNode;
  title: string;
  actions?: React.ReactNode;
  className?: string;
}) {
  const { t } = useI18n();
  const [maximized, setMaximized] = useState(false);
  const customButtons = usesCustomWindowButtons();

  useEffect(() => watchMaximized(setMaximized), []);

  /**
   * The native drag region only fires when the element under the cursor carries
   * the attribute, so grabbing the logo or the title would do nothing. Starting
   * the move ourselves makes the whole 40px bar behave like a real title bar.
   */
  const beginDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !isTauri()) return;
    const target = event.target as HTMLElement;
    if (target.closest('button, a, input, select, [role=combobox], [data-no-drag]')) return;
    void startWindowDrag();
  };

  const onDoubleClick = () => {
    // macOS owns the double-click behaviour of its overlay title bar.
    if (isMac()) return;
    void toggleMaximize();
  };

  return (
    <header
      data-tauri-drag-region
      onPointerDown={beginDrag}
      onDoubleClick={onDoubleClick}
      className={cn(
        'flex h-titlebar shrink-0 select-none items-center gap-3 border-b border-line bg-surface pr-2',
        isMac() ? 'pl-[78px]' : 'pl-3',
        className,
      )}
    >
      <div data-tauri-drag-region className="flex min-w-0 items-center gap-2">{brand}</div>
      <span data-tauri-drag-region className="h-4 w-px shrink-0 bg-line" />
      <span data-tauri-drag-region className="min-w-0 flex-1 truncate text-[12.5px] text-muted">
        {title}
      </span>
      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      {customButtons ? (
        <div className="flex shrink-0 items-center">
          <CaptionButton label={t('window.minimize')} onClick={() => void minimizeWindow()}>
            <Minus size={13} />
          </CaptionButton>
          <CaptionButton label={maximized ? t('window.restore') : t('window.maximize')} onClick={() => void toggleMaximize()}>
            {maximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          </CaptionButton>
          <CaptionButton label={t('window.close')} danger onClick={() => void closeWindow()}>
            <X size={14} />
          </CaptionButton>
        </div>
      ) : null}
    </header>
  );
}

function CaptionButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="default"
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        'h-full w-[46px] rounded-none border-0 bg-transparent p-0 text-muted active:translate-y-0 hover:bg-raised hover:text-ink',
        'focus-visible:ring-2 focus-visible:ring-accent/35',
        danger && 'hover:bg-bad hover:text-white',
      )}
    >
      {children}
    </Button>
  );
}
