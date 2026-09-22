import { forwardRef } from 'react';
import { Input as HeroInput } from '@heroui/react';
import { cn } from '../../utils.ts';

/** Shared field chrome; textareas keep everything but the fixed height. */
export const CONTROL_CLASS =
  'w-full min-w-0 rounded-control border border-line bg-surface px-2.5 text-[13px] text-ink outline-none transition placeholder:text-faint focus:border-accent focus:ring-2 focus:ring-accent/25 disabled:opacity-50';

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <HeroInput
      ref={ref}
      type={type}
      className={cn(CONTROL_CLASS, 'h-8', 'file:border-0 file:bg-transparent file:text-[12.5px] file:text-muted', className)}
      {...(props as unknown as React.ComponentProps<typeof HeroInput>)}
    />
  ),
);
Input.displayName = 'Input';
