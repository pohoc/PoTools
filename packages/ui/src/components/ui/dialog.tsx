import { Modal as HeroModal } from '@heroui/react';
import { cloneElement, isValidElement, type ComponentProps, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '../../utils.ts';

export function Dialog({ open, onOpenChange, children, ...props }: { open?: boolean; onOpenChange?: (open: boolean) => void; children: ReactNode } & Record<string, unknown>) {
  return <HeroModal.Root isOpen={open} onOpenChange={onOpenChange} {...props}>{children}</HeroModal.Root>;
}

/** Projects the trigger onto the child element instead of wrapping it in an extra node. */
export function DialogTrigger({ asChild = false, children, ...props }: React.HTMLAttributes<HTMLDivElement> & { asChild?: boolean }) {
  if (asChild && isValidElement(children)) {
    return (
      <HeroModal.Trigger
        {...props}
        render={(triggerProps) =>
          cloneElement(children, {
            ...triggerProps,
            className: cn(triggerProps.className, (children.props as { className?: string }).className),
          } as never)
        }
      />
    );
  }
  return <HeroModal.Trigger {...props}>{children}</HeroModal.Trigger>;
}

export function DialogClose({ asChild = false, children, ...props }: Omit<ComponentProps<typeof HeroModal.CloseTrigger>, 'render'> & { asChild?: boolean }) {
  if (asChild && isValidElement(children)) {
    return (
      <HeroModal.CloseTrigger
        {...props}
        render={(closeProps) =>
          cloneElement(children, {
            ...closeProps,
            className: cn(closeProps.className, (children.props as { className?: string }).className),
          } as never)
        }
      />
    );
  }
  return <HeroModal.CloseTrigger {...props}>{children}</HeroModal.CloseTrigger>;
}
export const DialogTitle = HeroModal.Heading;
export function DialogDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) { return <p className={className} {...props} />; }

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <HeroModal.Header className={cn('flex flex-col gap-1.5 pr-6 text-left', className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <HeroModal.Footer className={cn('mt-4 flex items-center justify-end gap-2', className)} {...props} />;
}

export function DialogContent({
  className,
  children,
  showClose = true,
  ...props
}: ComponentProps<typeof HeroModal.Dialog> & { showClose?: boolean; children?: ReactNode }) {
  return (
    <HeroModal.Backdrop className="fixed inset-0 z-50 bg-ink/35 backdrop-blur-[1px] data-[state=open]:animate-fade-up">
      <HeroModal.Container>
      <HeroModal.Dialog
        className={cn(
          'fixed left-1/2 top-1/2 z-50 w-[min(92vw,26rem)] -translate-x-1/2 -translate-y-1/2 rounded-card border border-line',
          'bg-surface p-4 shadow-pop outline-none data-[state=open]:animate-fade-up',
          className,
        )}
        {...props}
      >
        {children}
        {showClose ? (
          <HeroModal.CloseTrigger
            className="absolute right-3 top-3 rounded-control p-1 text-faint transition hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/35"
            aria-label="关闭"
          >
            <X size={15} />
          </HeroModal.CloseTrigger>
        ) : null}
      </HeroModal.Dialog>
      </HeroModal.Container>
    </HeroModal.Backdrop>
  );
}
