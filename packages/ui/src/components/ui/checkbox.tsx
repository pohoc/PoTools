import { forwardRef } from 'react';
import { cn } from '../../utils';

export const Checkbox = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input ref={ref} type="checkbox" className={cn('ui-choice-control size-4 cursor-pointer appearance-none rounded-sm border align-middle transition', 'checked:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30', 'disabled:cursor-not-allowed disabled:opacity-50', "checked:after:block checked:after:mx-auto checked:after:mt-[1px] checked:after:h-2 checked:after:w-1 checked:after:rotate-45 checked:after:border-b-2 checked:after:border-r-2 checked:after:border-accent-ink", className)} {...props} />
));
Checkbox.displayName = 'Checkbox';
