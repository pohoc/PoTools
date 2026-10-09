import { Switch as HeroSwitch } from '@heroui/react';
import type { ComponentProps } from 'react';
import { cn } from '../../utils.ts';

export function Switch({ className, checked, onCheckedChange, ...props }: ComponentProps<typeof HeroSwitch> & { checked?: boolean; onCheckedChange?: (value: boolean) => void }) {
  return <HeroSwitch
    isSelected={checked}
    onChange={onCheckedChange}
    className={cn(
      'relative h-[18px] w-[32px] shrink-0 cursor-pointer rounded-full bg-line outline-none transition',
      'focus-visible:ring-2 focus-visible:ring-accent/35 disabled:cursor-not-allowed disabled:opacity-45',
      'data-[state=checked]:bg-accent',
      className,
    )}
    {...props}
  />;
}
