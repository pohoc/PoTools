import { Disclosure as HeroDisclosure } from '@heroui/react';
import type { ComponentProps, ReactNode } from 'react';

export function Collapsible({ open, onOpenChange, children, ...props }: ComponentProps<typeof HeroDisclosure> & { open?: boolean; onOpenChange?: (open: boolean) => void }) {
  return <HeroDisclosure isExpanded={open} onExpandedChange={onOpenChange} {...props}>{children}</HeroDisclosure>;
}
export function CollapsibleTrigger({ asChild: _asChild, children, ...props }: ComponentProps<typeof HeroDisclosure.Trigger> & { asChild?: boolean }) {
  return <HeroDisclosure.Trigger {...props}>{children}</HeroDisclosure.Trigger>;
}
export function CollapsibleContent({ children, ...props }: ComponentProps<typeof HeroDisclosure.Content> & { children?: ReactNode }) {
  return <HeroDisclosure.Content {...props}>{children}</HeroDisclosure.Content>;
}
