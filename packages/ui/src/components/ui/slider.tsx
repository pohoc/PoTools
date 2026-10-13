import { Slider as HeroSlider } from '@heroui/react';
import type { ComponentProps } from 'react';
import { cn } from '../../utils';

/**
 * HeroUI v3 Slider is compound — Root alone collapses to 0x0, so assemble
 * Track + Fill + Thumb here. Fill width is derived from the slider state.
 */
export function Slider({ className, value, onValueChange, min, max, step, ...props }: ComponentProps<typeof HeroSlider> & { value?: number[]; onValueChange?: (value: number[]) => void; min?: number; max?: number; step?: number }) {
  const thumbs = Math.max(1, value?.length ?? 1);
  // react-aria warns once per thumb when the thumb carries no label, so every
  // thumb inherits the root's aria-label (numbered when there is more than one).
  const label = typeof props['aria-label'] === 'string' ? props['aria-label'] : undefined;
  return (
    <HeroSlider.Root
      className={cn('min-w-0', className)}
      value={value}
      onChange={(next) => onValueChange?.(Array.isArray(next) ? next.map(Number) : [Number(next)])}
      minValue={min}
      maxValue={max}
      step={step}
      {...props}
    >
      <HeroSlider.Track>
        <HeroSlider.Fill />
        {Array.from({ length: thumbs }, (_, index) => (
          <HeroSlider.Thumb
            key={index}
            aria-label={label && thumbs > 1 ? `${label} ${index + 1}` : label}
          />
        ))}
      </HeroSlider.Track>
    </HeroSlider.Root>
  );
}
