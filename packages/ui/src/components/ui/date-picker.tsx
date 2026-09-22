import { forwardRef } from 'react';
import { cn } from '../../utils';

export const DatePicker = forwardRef<HTMLInputElement, Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>>(({ className, ...props }, ref) => (
  <input ref={ref} type="date" className={cn('h-8 rounded-control border border-line bg-surface px-2.5 text-[13px] text-ink outline-none transition focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-50', className)} {...props} />
));
DatePicker.displayName = 'DatePicker';
