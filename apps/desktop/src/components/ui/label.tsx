import { forwardRef } from 'react';
import * as RadixLabel from '@radix-ui/react-label';
import { cn } from '../../lib/utils.ts';

export const Label = forwardRef<HTMLLabelElement, React.ComponentPropsWithoutRef<typeof RadixLabel.Root>>(
  ({ className, ...props }, ref) => (
    <RadixLabel.Root
      ref={ref}
      className={cn('text-[12.5px] font-medium leading-4 text-muted select-none', className)}
      {...props}
    />
  ),
);
Label.displayName = 'Label';
