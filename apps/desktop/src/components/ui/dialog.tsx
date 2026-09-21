import * as RadixDialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils.ts';

export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;
export const DialogTitle = RadixDialog.Title;
export const DialogDescription = RadixDialog.Description;

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1.5 pr-6 text-left', className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mt-4 flex items-center justify-end gap-2', className)} {...props} />;
}

export function DialogContent({
  className,
  children,
  showClose = true,
  ...props
}: React.ComponentPropsWithoutRef<typeof RadixDialog.Content> & { showClose?: boolean }) {
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="fixed inset-0 z-50 bg-ink/35 backdrop-blur-[1px] data-[state=open]:animate-fade-up" />
      <RadixDialog.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-50 w-[min(92vw,26rem)] -translate-x-1/2 -translate-y-1/2 rounded-card border border-line',
          'bg-surface p-4 shadow-pop outline-none data-[state=open]:animate-fade-up',
          className,
        )}
        {...props}
      >
        {children}
        {showClose ? (
          <RadixDialog.Close
            className="absolute right-3 top-3 rounded-control p-1 text-faint transition hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/35"
            aria-label="关闭"
          >
            <X size={15} />
          </RadixDialog.Close>
        ) : null}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}
