import { cloneElement, createContext, isValidElement, useContext, useId, type HTMLAttributes, type LabelHTMLAttributes, type ReactElement, type ReactNode } from 'react';
import { cn } from '../../utils';

const FieldContext = createContext<{ invalid?: boolean; controlId?: string; descriptionId?: string; messageId?: string }>({});
export function FormField({ invalid, id, className, children, ...props }: HTMLAttributes<HTMLDivElement> & { invalid?: boolean }) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  return <FieldContext.Provider value={{ invalid, controlId: `${fieldId}-control`, descriptionId: `${fieldId}-description`, messageId: `${fieldId}-message` }}><div id={id} className={cn('form-field', className)} {...props}>{children}</div></FieldContext.Provider>;
}
export function FormLabel({ className, required, children, htmlFor, ...props }: LabelHTMLAttributes<HTMLLabelElement> & { required?: boolean }) { const { invalid, controlId } = useContext(FieldContext); return <label htmlFor={htmlFor ?? controlId} className={cn('form-label', invalid && 'text-bad', className)} {...props}>{children}{required ? <span aria-hidden="true" className="ml-1 text-bad">*</span> : null}</label>; }
export function FormControl({ children }: { children: ReactElement }) { const { invalid, controlId, descriptionId, messageId } = useContext(FieldContext); if (!isValidElement(children)) return children; const describedBy = [descriptionId, invalid ? messageId : null].filter(Boolean).join(' '); return cloneElement(children, { id: (children.props as { id?: string }).id ?? controlId, 'aria-invalid': invalid || undefined, 'aria-describedby': describedBy || undefined } as never); }
export function FormDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) { const { descriptionId } = useContext(FieldContext); return <p id={descriptionId} className={cn('form-hint', className)} {...props} />; }
export function FormMessage({ className, children, ...props }: HTMLAttributes<HTMLParagraphElement> & { children?: ReactNode }) { const { messageId } = useContext(FieldContext); return children ? <p id={messageId} role="alert" className={cn('text-[11.5px] leading-4 text-bad', className)} {...props}>{children}</p> : null; }
export function FormSection({ className, title, description, children, ...props }: HTMLAttributes<HTMLFieldSetElement> & { title?: ReactNode; description?: ReactNode }) { return <fieldset className={cn('form-section form-field-stack', className)} {...props}>{title ? <legend className="form-section-title">{title}</legend> : null}{description ? <FormDescription>{description}</FormDescription> : null}{children}</fieldset>; }
