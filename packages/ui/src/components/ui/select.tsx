import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { Select as HeroSelect } from '@heroui/react';
import { ListBox, ListBoxItem } from 'react-aria-components/ListBox';
import { cn } from '../../utils.ts';

type SelectContextValue = { value?: string; onValueChange?: (value: string) => void };
const Context = createContext<SelectContextValue>({});

export function Select({ value, defaultValue, onValueChange, children, ...props }: { value?: string; defaultValue?: string; onValueChange?: (value: string) => void; children: ReactNode; className?: string; disabled?: boolean }) {
  const items = useMemo(() => {
    const result: { value: string; label: ReactNode; disabled?: boolean }[] = [];
    const visit = (node: ReactNode) => {
      if (!node) return;
      if (Array.isArray(node)) return node.forEach(visit);
      if (typeof node !== 'object' || !('props' in node)) return;
      const element = node as { type?: unknown; props?: { value?: string; children?: ReactNode; disabled?: boolean } };
      const elementProps = element.props;
      if (!elementProps) return;
      if (element.type === SelectItem && elementProps.value !== undefined) result.push({ value: elementProps.value, label: elementProps.children, disabled: elementProps.disabled });
      visit(elementProps.children);
    };
    visit(children);
    return result;
  }, [children]);
  return <Context.Provider value={{ value, onValueChange }}><HeroSelect selectedKey={value ?? defaultValue} onSelectionChange={(key) => onValueChange?.(String(key))} isDisabled={props.disabled} className={props.className}>
    <HeroSelect.Trigger><HeroSelect.Value /></HeroSelect.Trigger>
    <HeroSelect.Popover><ListBox>{items.map((item) => <ListBoxItem key={item.value} id={item.value} isDisabled={item.disabled}>{item.label}</ListBoxItem>)}</ListBox></HeroSelect.Popover>
  </HeroSelect></Context.Provider>;
}
export const SelectGroup = ({ children }: { children: ReactNode }) => <>{children}</>;
export function SelectValue({ placeholder }: { placeholder?: string }) { const context = useContext(Context); return <HeroSelect.Value>{({ selectedText }) => selectedText || context.value || placeholder}</HeroSelect.Value>; }

export function SelectTrigger({ className, children: _children, size = 'default', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { size?: 'sm' | 'default' }) {
  return <HeroSelect.Trigger
    className={cn(
      'flex w-full min-w-0 items-center justify-between gap-2 rounded-control border border-line bg-surface px-2.5 text-left text-[13px] text-ink outline-none transition',
      'hover:bg-raised/60 focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25',
      'data-[placeholder]:text-faint disabled:pointer-events-none disabled:opacity-50 [&>span]:truncate',
      size === 'sm' ? 'h-7' : 'h-8',
      className,
    )}
    {...(props as unknown as React.ComponentProps<typeof HeroSelect.Trigger>)}
  />;
}

/** Compatibility slot: Select parses SelectItem children from the declarative tree. */
export function SelectContent({ children: _children, className: _className, align: _align }: { children?: ReactNode; className?: string; align?: string }) { return null; }

export function SelectItem({ value, children, disabled }: { value: string; children: ReactNode; disabled?: boolean }) { return <span data-select-value={value} data-disabled={disabled}>{children}</span>; }

export function SelectLabel({ children }: { children: ReactNode }) { return <div className="px-2 py-1 text-[11.5px] text-faint">{children}</div>; }
