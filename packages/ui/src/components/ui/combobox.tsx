import { forwardRef, useId } from 'react';
import { cn } from '../../utils';

export type ComboboxOption = { value: string; label: string; disabled?: boolean };

export const Combobox = forwardRef<HTMLInputElement, Omit<React.InputHTMLAttributes<HTMLInputElement>, 'list'> & { options: ComboboxOption[] }>(
  ({ className, options, ...props }, ref) => {
    const id = useId();
    return <>
      <input ref={ref} list={id} role="combobox" aria-autocomplete="list" className={cn('h-8 w-full rounded-control border border-line bg-surface px-2.5 text-[13px] text-ink outline-none transition placeholder:text-faint focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-50', className)} {...props} />
      <datalist id={id}>{options.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}</datalist>
    </>;
  },
);
Combobox.displayName = 'Combobox';
