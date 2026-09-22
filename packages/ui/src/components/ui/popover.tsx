import { Popover as HeroPopover } from '@heroui/react';
import { cloneElement, isValidElement, type ComponentProps, type ReactNode } from 'react';
import { cn } from '../../utils.ts';

export const Popover = HeroPopover.Root;
export function PopoverTrigger({ className, children, asChild = false, ...props }: ComponentProps<typeof HeroPopover.Trigger> & { asChild?: boolean }) {
  if (asChild && isValidElement(children)) {
    const Trigger = HeroPopover.Trigger as unknown as React.ComponentType<any>;
    const childProps = children.props as { children?: ReactNode; className?: string };
    return <Trigger {...props} render={(triggerProps: React.HTMLAttributes<HTMLElement>) => cloneElement(children, {
      ...triggerProps,
      // The render callback can include an undefined children slot. Preserve the
      // authored child content so an asChild trigger never becomes icon/textless.
      children: childProps.children,
      className: cn(triggerProps.className, childProps.className),
    } as never)} />;
  }
  return <HeroPopover.Trigger className={className} {...props}>{children}</HeroPopover.Trigger>;
}

export function PopoverContent({ className, children, ...props }: ComponentProps<typeof HeroPopover.Content> & { children?: ReactNode }) {
  return <HeroPopover.Content className={cn('z-50 rounded-control border border-line bg-surface p-3 shadow-pop', className)} {...props}>{children}</HeroPopover.Content>;
}
