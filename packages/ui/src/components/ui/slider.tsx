import { Slider as HeroSlider } from '@heroui/react';
import type { ComponentProps } from 'react';
import { cn } from '../../utils.ts';

export function Slider({ className, value, onValueChange, min, max, step, ...props }: ComponentProps<typeof HeroSlider> & { value?: number[]; onValueChange?: (value: number[]) => void; min?: number; max?: number; step?: number }) {
  return <HeroSlider className={cn('min-w-0', className)} value={value?.[0]} onChange={(next) => onValueChange?.([Number(next)])} minValue={min} maxValue={max} step={step} {...props} />;
}
