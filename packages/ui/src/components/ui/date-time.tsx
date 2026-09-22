import { forwardRef } from 'react';
import { cn } from '../../utils';

const control = 'h-8 rounded-control border border-line bg-surface px-2.5 text-[13px] text-ink outline-none transition focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-50';

export const TimePicker = forwardRef<HTMLInputElement, Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>>(({ className, ...props }, ref) => (
  <input ref={ref} type="time" className={cn(control, className)} {...props} />
));
TimePicker.displayName = 'TimePicker';

export const DateTimePicker = forwardRef<HTMLInputElement, Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>>(({ className, ...props }, ref) => (
  <input ref={ref} type="datetime-local" className={cn(control, className)} {...props} />
));
DateTimePicker.displayName = 'DateTimePicker';

export const MonthPicker = forwardRef<HTMLInputElement, Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>>(({ className, ...props }, ref) => (
  <input ref={ref} type="month" className={cn(control, className)} {...props} />
));
MonthPicker.displayName = 'MonthPicker';

export function DateRangePicker({ start, end, onStartChange, onEndChange, className, disabled, ...props }: { start?: string; end?: string; onStartChange?: (value: string) => void; onEndChange?: (value: string) => void; className?: string; disabled?: boolean } & Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange'>) {
  return <div className={cn('flex items-center gap-2', className)} {...props}>
    <input aria-label="Start date" type="date" value={start ?? ''} onChange={(event) => onStartChange?.(event.target.value)} disabled={disabled} className={cn(control, 'min-w-0 flex-1')} />
    <span aria-hidden="true" className="text-faint">–</span>
    <input aria-label="End date" type="date" value={end ?? ''} min={start} onChange={(event) => onEndChange?.(event.target.value)} disabled={disabled} className={cn(control, 'min-w-0 flex-1')} />
  </div>;
}

export function TimeRangePicker({ start, end, onStartChange, onEndChange, className, disabled, ...props }: { start?: string; end?: string; onStartChange?: (value: string) => void; onEndChange?: (value: string) => void; className?: string; disabled?: boolean } & Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange'>) {
  return <div className={cn('flex items-center gap-2', className)} {...props}>
    <input aria-label="Start time" type="time" value={start ?? ''} onChange={(event) => onStartChange?.(event.target.value)} disabled={disabled} className={cn(control, 'min-w-0 flex-1')} />
    <span aria-hidden="true" className="text-faint">–</span>
    <input aria-label="End time" type="time" value={end ?? ''} min={start} onChange={(event) => onEndChange?.(event.target.value)} disabled={disabled} className={cn(control, 'min-w-0 flex-1')} />
  </div>;
}

export function DateTimeRangePicker({ start, end, onStartChange, onEndChange, className, disabled, ...props }: { start?: string; end?: string; onStartChange?: (value: string) => void; onEndChange?: (value: string) => void; className?: string; disabled?: boolean } & Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange'>) {
  return <div className={cn('flex flex-wrap items-center gap-2', className)} {...props}>
    <input aria-label="Start date and time" type="datetime-local" value={start ?? ''} onChange={(event) => onStartChange?.(event.target.value)} disabled={disabled} className={cn(control, 'min-w-0 flex-1')} />
    <span aria-hidden="true" className="text-faint">–</span>
    <input aria-label="End date and time" type="datetime-local" value={end ?? ''} min={start} onChange={(event) => onEndChange?.(event.target.value)} disabled={disabled} className={cn(control, 'min-w-0 flex-1')} />
  </div>;
}

export const DurationInput = forwardRef<HTMLInputElement, Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>>(({ className, min = 0, step = 60, ...props }, ref) => (
  <div className="relative">
    <input ref={ref} type="number" min={min} step={step} inputMode="decimal" aria-label={props['aria-label'] ?? 'Duration in seconds'} className={cn(control, 'w-full pr-16', className)} {...props} />
    <span aria-hidden="true" className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-faint">seconds</span>
  </div>
));
DurationInput.displayName = 'DurationInput';
