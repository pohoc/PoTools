import { forwardRef } from 'react';
import * as RadixSlider from '@radix-ui/react-slider';
import { cn } from '../../lib/utils.ts';

export const Slider = forwardRef<HTMLSpanElement, React.ComponentPropsWithoutRef<typeof RadixSlider.Root>>(
  ({ className, ...props }, ref) => (
    <RadixSlider.Root
      ref={ref}
      className={cn('relative flex h-8 w-full touch-none select-none items-center', className)}
      {...props}
    >
      <RadixSlider.Track className="relative h-1 w-full grow overflow-hidden rounded-full bg-raised">
        <RadixSlider.Range className="absolute h-full bg-accent" />
      </RadixSlider.Track>
      <RadixSlider.Thumb
        className="block h-3.5 w-3.5 rounded-full border border-line bg-surface shadow-sm outline-none transition
          hover:border-accent focus-visible:ring-2 focus-visible:ring-accent/35"
      />
    </RadixSlider.Root>
  ),
);
Slider.displayName = 'Slider';
