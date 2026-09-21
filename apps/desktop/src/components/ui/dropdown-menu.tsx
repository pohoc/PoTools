import * as RadixDropdown from '@radix-ui/react-dropdown-menu';
import { Check } from 'lucide-react';
import { cn } from '../../lib/utils.ts';

export const DropdownMenu = RadixDropdown.Root;
export const DropdownMenuTrigger = RadixDropdown.Trigger;
export const DropdownMenuGroup = RadixDropdown.Group;
export const DropdownMenuRadioGroup = RadixDropdown.RadioGroup;
export const DropdownMenuLabel = RadixDropdown.Label;

export const DropdownMenuSeparator = () => <RadixDropdown.Separator className="my-1 h-px bg-line" />;

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  ...props
}: React.ComponentPropsWithoutRef<typeof RadixDropdown.Content>) {
  return (
    <RadixDropdown.Portal>
      <RadixDropdown.Content
        sideOffset={sideOffset}
        className={cn(
          'z-50 min-w-[10rem] overflow-hidden rounded-control border border-line bg-surface p-1 shadow-pop',
          'data-[state=open]:animate-fade-up',
          className,
        )}
        {...props}
      />
    </RadixDropdown.Portal>
  );
}

const itemClass =
  'relative flex cursor-pointer select-none items-center gap-2 rounded-[7px] px-2 py-1.5 text-[12.5px] text-ink outline-none transition data-[highlighted]:bg-raised data-[disabled]:pointer-events-none data-[disabled]:opacity-45';

export function DropdownMenuItem({ className, ...props }: React.ComponentPropsWithoutRef<typeof RadixDropdown.Item>) {
  return <RadixDropdown.Item className={cn(itemClass, className)} {...props} />;
}

export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof RadixDropdown.RadioItem>) {
  return (
    <RadixDropdown.RadioItem className={cn(itemClass, 'pl-7', className)} {...props}>
      <RadixDropdown.ItemIndicator className="absolute left-2 flex items-center text-accent">
        <Check size={13} strokeWidth={2.5} />
      </RadixDropdown.ItemIndicator>
      {children}
    </RadixDropdown.RadioItem>
  );
}
