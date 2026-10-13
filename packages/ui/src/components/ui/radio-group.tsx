import { createContext, useContext, useId, useMemo, useState, type ReactNode } from 'react';
import { cn } from '../../utils';
const RadioGroupContext = createContext<{ value?: string; name: string; onValueChange?: (value: string) => void }>({ name: '' });
export function RadioGroup({ value, defaultValue, onValueChange, name, className, children, ...props }: { value?: string; defaultValue?: string; onValueChange?: (value: string) => void; name?: string; className?: string; children: ReactNode }) {
  const generatedName = useId();
  const [internalValue, setInternalValue] = useState(defaultValue);
  const selected = value === undefined ? internalValue : value;
  const contextValue = useMemo(() => ({
    value: selected,
    name: name ?? generatedName,
    onValueChange: (next: string) => { if (value === undefined) setInternalValue(next); onValueChange?.(next); },
  }), [selected, generatedName, name, value, onValueChange]);
  return <RadioGroupContext.Provider value={contextValue}><div role="radiogroup" className={cn('flex flex-col gap-2', className)} {...props}>{children}</div></RadioGroupContext.Provider>;
}
export function RadioGroupItem({ value, id, className, disabled, children }: { value: string; id?: string; className?: string; disabled?: boolean; children?: ReactNode }) { const context = useContext(RadioGroupContext); return <label htmlFor={id} className={cn('inline-flex cursor-pointer items-center gap-2 text-[13px] text-ink', disabled && 'cursor-not-allowed opacity-50', className)}><input id={id} type="radio" name={context.name} value={value} checked={context.value === value} onChange={() => context.onValueChange?.(value)} disabled={disabled} className="ui-choice-control size-4 cursor-pointer rounded-full border" />{children}</label>; }
