import { forwardRef, useId } from 'react';
import { cn } from '../../utils';

export type ComboboxOption = { value: string; label: string; disabled?: boolean };

export const Combobox = forwardRef<HTMLInputElement, Omit<React.InputHTMLAttributes<HTMLInputElement>, 'list'> & { options: ComboboxOption[] }>(
  ({ className, options, ...props }, ref) => {
    const id = useId();
    return <>
      <input ref={ref} list={id} role="combobox" aria-autocomplete="list" className={cn('ui-field-control ui-control-md w-full px-2.5 text-[13px] outline-none transition placeholder:text-faint', className)} {...props} />
      <datalist id={id}>{options.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}</datalist>
    </>;
  },
);
Combobox.displayName = 'Combobox';
