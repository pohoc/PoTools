import { forwardRef } from 'react';
import { cn } from '../../utils';

export const DatePicker = forwardRef<HTMLInputElement, Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>>(({ className, ...props }, ref) => (
  <input ref={ref} type="date" className={cn('ui-field-control ui-control-md px-2.5 text-[13px] outline-none transition', className)} {...props} />
));
DatePicker.displayName = 'DatePicker';
