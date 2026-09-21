import * as RadixSeparator from '@radix-ui/react-separator';
import { cn } from '../../lib/utils.ts';

export function Separator({
  className,
  orientation = 'horizontal',
  ...props
}: React.ComponentPropsWithoutRef<typeof RadixSeparator.Root>) {
  return (
    <RadixSeparator.Root
      orientation={orientation}
      className={cn(
        'shrink-0 bg-line',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        className,
      )}
      {...props}
    />
  );
}
