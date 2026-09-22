import type { ReactNode } from 'react';
import { Select as HeroSelect } from '@heroui/react';
import { Header, ListBox, ListBoxItem, ListBoxSection } from 'react-aria-components/ListBox';
import { Check } from 'lucide-react';
import { cn } from '../../utils.ts';

/**
 * shadcn-style declarative Select on top of HeroUI's compound Select.
 * Each slot maps onto the real HeroUI/react-aria primitive, so items flow
 * through React's normal data flow instead of being parsed out of the tree.
 */
export function Select({
  value,
  defaultValue,
  onValueChange,
  disabled,
  className,
  children,
}: {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <HeroSelect
      selectedKey={value}
      defaultSelectedKey={defaultValue}
      onSelectionChange={(key) => onValueChange?.(String(key))}
      isDisabled={disabled}
      className={className}
    >
      {children}
    </HeroSelect>
  );
}

export function SelectTrigger({
  className,
  children,
  size = 'default',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { size?: 'sm' | 'default' }) {
  return (
    <HeroSelect.Trigger
      className={cn(
        'ui-field-control flex w-full min-w-0 items-center justify-between gap-2 rounded-control px-2.5 text-left text-[13px] outline-none transition',
        'data-[placeholder]:text-faint disabled:pointer-events-none disabled:opacity-50 [&>span]:truncate',
        size === 'sm' ? 'ui-control-sm' : 'ui-control-md',
        className,
      )}
      {...(props as unknown as React.ComponentProps<typeof HeroSelect.Trigger>)}
    />
  );
}

export function SelectValue({ placeholder }: { placeholder?: string }) {
  return (
    <HeroSelect.Value>
      {({ selectedText, isPlaceholder }: { selectedText: string; isPlaceholder: boolean }) =>
        isPlaceholder ? (placeholder ?? '') : selectedText
      }
    </HeroSelect.Value>
  );
}

export function SelectContent({
  className,
  align,
  children,
}: {
  className?: string;
  align?: 'start' | 'center' | 'end';
  children?: ReactNode;
}) {
  return (
    <HeroSelect.Popover
      placement={align === 'start' || align === 'end' ? `bottom ${align}` : 'bottom'}
      offset={6}
      className="z-50 min-w-[10rem] overflow-hidden rounded-overlay border border-line bg-surface p-1 shadow-pop data-[state=open]:animate-fade-up"
    >
      <ListBox className={cn('max-h-72 w-full min-w-(--trigger-width) outline-none', className)}>{children}</ListBox>
    </HeroSelect.Popover>
  );
}

const itemClass =
  'group relative flex cursor-pointer select-none items-center gap-2 rounded-sm py-1.5 pl-2 pr-7 text-[12.5px] text-ink outline-none transition data-[focused]:bg-raised data-[selected]:font-medium data-[disabled]:pointer-events-none data-[disabled]:opacity-45';

export function SelectItem({
  value,
  disabled,
  className,
  children,
}: {
  value: string;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <ListBoxItem id={value} isDisabled={disabled} textValue={toText(children)} className={cn(itemClass, className)}>
      {children}
      <Check size={13} strokeWidth={2.5} className="absolute right-2 hidden text-accent group-data-[selected]:block" />
    </ListBoxItem>
  );
}

export function SelectGroup({ children }: { children: ReactNode }) {
  return <ListBoxSection>{children}</ListBoxSection>;
}

export function SelectLabel({ children }: { children: ReactNode }) {
  return <Header className="px-2 py-1 text-[11.5px] text-faint">{children}</Header>;
}

/** Plain-text projection of the item label for screen readers and the trigger. */
function toText(node: ReactNode): string {
  if (node == null || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(toText).join('');
  if (typeof node === 'object' && 'props' in node) {
    const element = node as { props?: { children?: ReactNode } };
    return toText(element.props?.children);
  }
  return '';
}
