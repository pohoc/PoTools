import { forwardRef } from 'react';
import { cn } from '../../utils.ts';

export const Label = forwardRef<HTMLLabelElement, React.LabelHTMLAttributes<HTMLLabelElement>>(
  ({ className, ...props }, ref) => (
    <label
      ref={ref}
      className={cn('text-[12.5px] font-medium leading-4 text-muted select-none', className)}
      {...props}
    />
  ),
);
Label.displayName = 'Label';
