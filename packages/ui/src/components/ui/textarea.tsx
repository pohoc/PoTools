import { forwardRef } from 'react';
import { cn } from '../../utils';

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn('ui-field-control ui-textarea-control w-full resize-y px-2.5 py-2 text-[13px] outline-none transition placeholder:text-faint', className)} {...props} />
));
Textarea.displayName = 'Textarea';
