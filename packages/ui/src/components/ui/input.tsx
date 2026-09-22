import { forwardRef } from 'react';
import { Input as HeroInput } from '@heroui/react';
import { cn } from '../../utils.ts';

/** Shared field chrome; textareas keep everything but the fixed height. */
export const CONTROL_CLASS =
  'ui-field-control w-full min-w-0 rounded-control px-2.5 text-[13px] outline-none transition placeholder:text-faint';

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <HeroInput
      ref={ref}
      type={type}
      className={cn(CONTROL_CLASS, 'ui-control-md', 'file:border-0 file:bg-transparent file:text-[12.5px] file:text-muted', className)}
      {...(props as unknown as React.ComponentProps<typeof HeroInput>)}
    />
  ),
);
Input.displayName = 'Input';
