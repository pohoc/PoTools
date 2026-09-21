import * as RadixProgress from '@radix-ui/react-progress';
import { cn } from '../../lib/utils.ts';

export function Progress({
  className,
  value = 0,
  indicatorClassName,
  ...props
}: React.ComponentPropsWithoutRef<typeof RadixProgress.Root> & { indicatorClassName?: string }) {
  return (
    <RadixProgress.Root
      className={cn('relative h-1.5 w-full overflow-hidden rounded-full bg-raised', className)}
      value={value}
      {...props}
    >
      <RadixProgress.Indicator
        className={cn('h-full bg-accent transition-transform duration-300', indicatorClassName)}
        style={{ transform: `translateX(-${100 - (value ?? 0)}%)` }}
      />
    </RadixProgress.Root>
  );
}
