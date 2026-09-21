import { forwardRef } from 'react';
import { cn } from '../../lib/utils.ts';

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        'h-8 w-full min-w-0 rounded-control border border-line bg-surface px-2.5 text-[13px] text-ink outline-none transition',
        'placeholder:text-faint focus:border-accent focus:ring-2 focus:ring-accent/25 disabled:opacity-50',
        'file:border-0 file:bg-transparent file:text-[12.5px] file:text-muted',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';
