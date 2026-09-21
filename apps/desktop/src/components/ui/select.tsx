import { forwardRef } from 'react';
import * as RadixSelect from '@radix-ui/react-select';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '../../lib/utils.ts';

export const Select = RadixSelect.Root;
export const SelectGroup = RadixSelect.Group;
export const SelectValue = RadixSelect.Value;

export const SelectTrigger = forwardRef<
  React.ElementRef<typeof RadixSelect.Trigger>,
  React.ComponentPropsWithoutRef<typeof RadixSelect.Trigger> & { size?: 'sm' | 'default' }
>(({ className, children, size = 'default', ...props }, ref) => (
  <RadixSelect.Trigger
    ref={ref}
    className={cn(
      'flex w-full min-w-0 items-center justify-between gap-2 rounded-control border border-line bg-surface px-2.5 text-left text-[13px] text-ink outline-none transition',
      'hover:bg-raised/60 focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25',
      'data-[placeholder]:text-faint disabled:pointer-events-none disabled:opacity-50 [&>span]:truncate',
      size === 'sm' ? 'h-7' : 'h-8',
      className,
    )}
    {...props}
  >
    {children}
    <RadixSelect.Icon className="shrink-0 text-faint">
      <ChevronDown size={14} />
    </RadixSelect.Icon>
  </RadixSelect.Trigger>
));
SelectTrigger.displayName = 'SelectTrigger';

export const SelectContent = forwardRef<
  React.ElementRef<typeof RadixSelect.Content>,
  React.ComponentPropsWithoutRef<typeof RadixSelect.Content>
>(({ className, children, position = 'popper', ...props }, ref) => (
  <RadixSelect.Portal>
    <RadixSelect.Content
      ref={ref}
      position={position}
      className={cn(
        'z-50 max-h-[22rem] min-w-[8rem] overflow-hidden rounded-control border border-line bg-surface shadow-pop',
        position === 'popper' && 'data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1',
        className,
      )}
      {...props}
    >
      <RadixSelect.ScrollUpButton className="flex h-6 items-center justify-center text-faint">
        <ChevronUp size={14} />
      </RadixSelect.ScrollUpButton>
      <RadixSelect.Viewport className="p-1">{children}</RadixSelect.Viewport>
      <RadixSelect.ScrollDownButton className="flex h-6 items-center justify-center text-faint">
        <ChevronDown size={14} />
      </RadixSelect.ScrollDownButton>
    </RadixSelect.Content>
  </RadixSelect.Portal>
));
SelectContent.displayName = 'SelectContent';

export const SelectItem = forwardRef<
  React.ElementRef<typeof RadixSelect.Item>,
  React.ComponentPropsWithoutRef<typeof RadixSelect.Item>
>(({ className, children, ...props }, ref) => (
  <RadixSelect.Item
    ref={ref}
    className={cn(
      'relative flex cursor-pointer select-none items-center gap-2 rounded-[7px] py-1.5 pl-7 pr-2 text-[12.5px] text-ink outline-none',
      'data-[highlighted]:bg-raised data-[state=checked]:font-medium data-[disabled]:pointer-events-none data-[disabled]:opacity-45',
      className,
    )}
    {...props}
  >
    <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center text-accent">
      <RadixSelect.ItemIndicator>
        <Check size={13} strokeWidth={2.5} />
      </RadixSelect.ItemIndicator>
    </span>
    <RadixSelect.ItemText className="truncate">{children}</RadixSelect.ItemText>
  </RadixSelect.Item>
));
SelectItem.displayName = 'SelectItem';

export const SelectLabel = forwardRef<
  React.ElementRef<typeof RadixSelect.Label>,
  React.ComponentPropsWithoutRef<typeof RadixSelect.Label>
>(({ className, ...props }, ref) => (
  <RadixSelect.Label ref={ref} className={cn('px-2 py-1 text-[11.5px] text-faint', className)} {...props} />
));
SelectLabel.displayName = 'SelectLabel';
