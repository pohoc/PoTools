import * as RadixTooltip from '@radix-ui/react-tooltip';
import { cn } from '../../lib/utils.ts';

export const TooltipProvider = RadixTooltip.Provider;
export const Tooltip = RadixTooltip.Root;
export const TooltipTrigger = RadixTooltip.Trigger;

export function TooltipContent({
  className,
  sideOffset = 6,
  ...props
}: React.ComponentPropsWithoutRef<typeof RadixTooltip.Content>) {
  return (
    <RadixTooltip.Portal>
      <RadixTooltip.Content
        sideOffset={sideOffset}
        className={cn(
          'z-50 max-w-[18rem] rounded-md border border-line bg-surface px-2 py-1 text-[11.5px] leading-4 text-muted shadow-pop',
          'data-[state=delayed-open]:animate-fade-up',
          className,
        )}
        {...props}
      />
    </RadixTooltip.Portal>
  );
}
