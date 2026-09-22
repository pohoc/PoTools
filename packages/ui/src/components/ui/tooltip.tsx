import { Tooltip as HeroTooltip } from '@heroui/react';
import type { ComponentProps } from 'react';
import { cn } from '../../utils.ts';

export const TooltipProvider = ({ children, delayDuration: _delayDuration }: { children: React.ReactNode; delayDuration?: number }) => <>{children}</>;
export function Tooltip({ children, delayDuration, ...props }: ComponentProps<typeof HeroTooltip.Root> & { delayDuration?: number }) {
  return <HeroTooltip.Root delay={delayDuration} {...props}>{children}</HeroTooltip.Root>;
}
export function TooltipTrigger({ asChild: _asChild, delayDuration: _delayDuration, children, ...props }: ComponentProps<typeof HeroTooltip.Trigger> & { asChild?: boolean; delayDuration?: number }) {
  return <HeroTooltip.Trigger {...props}>{children}</HeroTooltip.Trigger>;
}

export function TooltipContent({
  className,
  sideOffset = 6,
  side = 'bottom',
  ...props
}: ComponentProps<typeof HeroTooltip.Content> & { sideOffset?: number; side?: 'top' | 'right' | 'bottom' | 'left' }) {
  return (
      <HeroTooltip.Content
        placement={side}
        offset={sideOffset}
        className={cn(
          'z-50 max-w-[18rem] rounded-md border border-line bg-surface px-2 py-1 text-[11.5px] leading-4 text-muted shadow-pop',
          'data-[state=delayed-open]:animate-fade-up',
          className,
        )}
        {...props}
      />
  );
}
