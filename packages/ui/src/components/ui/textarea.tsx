import { forwardRef } from 'react';
import { cn } from '../../utils';

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn('min-h-20 w-full resize-y rounded-control border border-line bg-surface px-2.5 py-2 text-[13px] text-ink outline-none transition', 'placeholder:text-faint focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25', 'disabled:cursor-not-allowed disabled:opacity-50', className)} {...props} />
));
Textarea.displayName = 'Textarea';
