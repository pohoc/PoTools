import { Dropdown as HeroDropdown } from '@heroui/react';
import { createContext, useContext, type ComponentProps, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { cn } from '../../utils.ts';

export const DropdownMenu = HeroDropdown.Root;
export function DropdownMenuTrigger({ asChild: _asChild, children, ...props }: ComponentProps<typeof HeroDropdown.Trigger> & { asChild?: boolean }) { return <HeroDropdown.Trigger {...props}>{children}</HeroDropdown.Trigger>; }
export const DropdownMenuGroup = ({ children }: { children: ReactNode }) => <>{children}</>;
const RadioContext = createContext<{ value?: string; onValueChange?: (value: string) => void }>({});
export function DropdownMenuRadioGroup({ value, onValueChange, children }: { value?: string; onValueChange?: (value: string) => void; children: ReactNode }) { return <RadioContext.Provider value={{ value, onValueChange }}>{children}</RadioContext.Provider>; }
export const DropdownMenuLabel = ({ children, className }: { children: ReactNode; className?: string }) => <div className={cn('px-2 py-1 text-[11.5px] text-faint', className)}>{children}</div>;

export const DropdownMenuSeparator = () => <div className="my-1 h-px bg-line" />;

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: ComponentProps<typeof HeroDropdown.Popover> & { align?: string; sideOffset?: number; children?: ReactNode }) {
  return (
      <HeroDropdown.Popover
        className={cn(
          'z-50 min-w-[10rem] overflow-hidden rounded-control border border-line bg-surface p-1 shadow-pop',
          'data-[state=open]:animate-fade-up',
          className,
        )}
        {...props}
      ><HeroDropdown.Menu>{children}</HeroDropdown.Menu></HeroDropdown.Popover>
  );
}

const itemClass =
  'relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-[12.5px] text-ink outline-none transition data-[highlighted]:bg-raised data-[disabled]:pointer-events-none data-[disabled]:opacity-45';

export function DropdownMenuItem({ className, ...props }: ComponentProps<typeof HeroDropdown.Item>) {
  return <HeroDropdown.Item className={cn(itemClass, className)} {...props} />;
}

export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof HeroDropdown.Item>, 'children'> & { value: string; children?: ReactNode }) {
  const radio = useContext(RadioContext);
  return (
    <HeroDropdown.Item className={cn(itemClass, 'pl-7', className)} {...props} onAction={() => radio.onValueChange?.(props.value)}>
      {radio.value === props.value ? <Check size={13} strokeWidth={2.5} className="absolute left-2 text-accent" /> : null}
      {children}
    </HeroDropdown.Item>
  );
}
