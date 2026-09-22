import { createContext, useContext, useId, useState, type ReactNode } from 'react';
import { cn } from '../../utils';
const RadioGroupContext = createContext<{ value?: string; name: string; onValueChange?: (value: string) => void }>({ name: '' });
export function RadioGroup({ value, defaultValue, onValueChange, name, className, children, ...props }: { value?: string; defaultValue?: string; onValueChange?: (value: string) => void; name?: string; className?: string; children: ReactNode }) {
  const generatedName = useId();
  const [internalValue, setInternalValue] = useState(defaultValue);
  const selected = value === undefined ? internalValue : value;
  const update = (next: string) => { if (value === undefined) setInternalValue(next); onValueChange?.(next); };
  return <RadioGroupContext.Provider value={{ value: selected, name: name ?? generatedName, onValueChange: update }}><div role="radiogroup" className={cn('flex flex-col gap-2', className)} {...props}>{children}</div></RadioGroupContext.Provider>;
}
export function RadioGroupItem({ value, id, className, disabled, children }: { value: string; id?: string; className?: string; disabled?: boolean; children?: ReactNode }) { const context = useContext(RadioGroupContext); return <label htmlFor={id} className={cn('inline-flex cursor-pointer items-center gap-2 text-[13px] text-ink', disabled && 'cursor-not-allowed opacity-50', className)}><input id={id} type="radio" name={context.name} value={value} checked={context.value === value} onChange={() => context.onValueChange?.(value)} disabled={disabled} className="size-4 cursor-pointer accent-[rgb(var(--c-accent))]" />{children}</label>; }
