import { Toaster as SonnerToaster, type ToasterProps } from 'sonner';
import { useSettings } from '../../lib/settings.ts';

/** Toasts styled with the app palette instead of sonner's defaults. */
export function Toaster(props: ToasterProps) {
  const theme = useSettings((state) => state.theme);
  const resolved =
    theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : theme;
  return (
    <SonnerToaster
      theme={resolved as ToasterProps['theme']}
      position="bottom-right"
      closeButton
      toastOptions={{
        classNames: {
          toast:
            '!bg-surface !text-ink !border-line !rounded-card !shadow-pop !text-[12.5px] !py-2.5 !px-3',
          description: '!text-muted !text-[12px]',
          actionButton: '!bg-accent !text-accent-ink !rounded-control',
          cancelButton: '!bg-raised !text-muted !rounded-control',
          success: '!text-ok',
          error: '!text-bad',
          warning: '!text-warn',
        },
      }}
      {...props}
    />
  );
}
