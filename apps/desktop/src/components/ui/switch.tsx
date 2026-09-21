import { forwardRef } from 'react';
import * as RadixSwitch from '@radix-ui/react-switch';
import { cn } from '../../lib/utils.ts';

export const Switch = forwardRef<
  React.ElementRef<typeof RadixSwitch.Root>,
  React.ComponentPropsWithoutRef<typeof RadixSwitch.Root>
>(({ className, ...props }, ref) => (
  <RadixSwitch.Root
    ref={ref}
    className={cn(
      'relative h-[18px] w-[32px] shrink-0 cursor-pointer rounded-full bg-line outline-none transition',
      'focus-visible:ring-2 focus-visible:ring-accent/35 disabled:cursor-not-allowed disabled:opacity-45',
      'data-[state=checked]:bg-accent',
      className,
    )}
    {...props}
  >
    <RadixSwitch.Thumb className="block h-[14px] w-[14px] translate-x-0.5 rounded-full bg-surface shadow-sm transition-transform data-[state=checked]:translate-x-[15px]" />
  </RadixSwitch.Root>
));
Switch.displayName = 'Switch';
