import { forwardRef } from 'react';
import { cn } from '../../utils.ts';

export const ScrollArea = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, children, ...props }, ref) => (
    <div ref={ref} className={cn('relative w-full overflow-auto', className)} {...props}>{children}</div>
  ),
);
ScrollArea.displayName = 'ScrollArea';
