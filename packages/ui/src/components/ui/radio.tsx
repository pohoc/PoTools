import { forwardRef } from 'react';
import { cn } from '../../utils';

export const Radio = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input ref={ref} type="radio" className={cn('ui-choice-control size-4 cursor-pointer appearance-none rounded-full border align-middle transition', 'checked:border-[5px] checked:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30', 'disabled:cursor-not-allowed disabled:opacity-50', className)} {...props} />
));
Radio.displayName = 'Radio';
