import { ProgressBar } from '@heroui/react';
import { cn } from '../../utils.ts';

export function Progress({
  className,
  value = 0,
  indicatorClassName,
  ...props
}: React.ComponentProps<typeof ProgressBar> & { indicatorClassName?: string }) {
  return (
    <ProgressBar
      className={cn('relative h-1.5 w-full overflow-hidden rounded-full bg-raised', className)}
      value={value}
      {...props}
    />
  );
}
