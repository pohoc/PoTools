import { Popover as HeroPopover } from '@heroui/react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../utils.ts';

export const Popover = HeroPopover.Root;
export function PopoverTrigger({ className, children, asChild: _asChild, ...props }: ComponentProps<typeof HeroPopover.Trigger> & { asChild?: boolean }) {
  return <HeroPopover.Trigger className={className} {...props}>{children}</HeroPopover.Trigger>;
}

export function PopoverContent({ className, children, ...props }: ComponentProps<typeof HeroPopover.Content> & { children?: ReactNode }) {
  return <HeroPopover.Content className={cn('z-50 rounded-control border border-line bg-surface p-3 shadow-pop', className)} {...props}>{children}</HeroPopover.Content>;
}
