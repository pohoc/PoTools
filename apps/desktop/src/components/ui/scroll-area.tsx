import { forwardRef } from 'react';
import * as RadixScroll from '@radix-ui/react-scroll-area';
import { cn } from '../../lib/utils.ts';

export const ScrollArea = forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof RadixScroll.Root>>(
  ({ className, children, ...props }, ref) => (
    <RadixScroll.Root ref={ref} className={cn('relative w-full overflow-hidden', className)} {...props}>
      <RadixScroll.Viewport className="h-full w-full">{children}</RadixScroll.Viewport>
      <RadixScroll.Scrollbar className="flex touch-none p-0.5 transition-colors data-[orientation=vertical]:h-full data-[orientation=vertical]:w-2" orientation="vertical">
        <RadixScroll.Thumb className="relative flex-1 rounded-full bg-line" />
      </RadixScroll.Scrollbar>
      <RadixScroll.Scrollbar className="flex h-2 touch-none flex-col p-0.5" orientation="horizontal">
        <RadixScroll.Thumb className="relative flex-1 rounded-full bg-line" />
      </RadixScroll.Scrollbar>
    </RadixScroll.Root>
  ),
);
ScrollArea.displayName = 'ScrollArea';
