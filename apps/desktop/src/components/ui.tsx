import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { Icon } from './Icon.tsx';
import { Button as ShadcnButton } from './ui/button.tsx';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card.tsx';
import { Progress } from './ui/progress.tsx';
import { Switch } from './ui/switch.tsx';
import { Tabs, TabsList, TabsTrigger } from './ui/tabs.tsx';
import { useI18n } from '../i18n/index.tsx';
import { cn } from '../lib/utils.ts';
import type { JobState } from 'core';

type Variant = 'primary' | 'ghost' | 'quiet' | 'outline' | 'danger' | 'link';

const VARIANT: Record<Variant, 'default' | 'secondary' | 'ghost' | 'outline' | 'danger' | 'link'> = {
  primary: 'default',
  ghost: 'secondary',
  quiet: 'ghost',
  outline: 'outline',
  danger: 'danger',
  link: 'link',
};

/** App-level button: shadcn Button plus an icon slot and a busy state. */
export function Button({
  variant = 'ghost',
  icon,
  iconSize = 15,
  size = 'md',
  busy,
  children,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  icon?: string;
  iconSize?: number;
  size?: 'sm' | 'md' | 'lg';
  busy?: boolean;
}) {
  return (
    <ShadcnButton
      type="button"
      variant={VARIANT[variant]}
      size={size === 'md' ? 'default' : size}
      className={className}
      disabled={rest.disabled || busy}
      {...rest}
    >
      {busy ? <Loader2 size={iconSize} className="animate-spin" /> : icon ? <Icon name={icon} size={iconSize} /> : null}
      {children}
    </ShadcnButton>
  );
}

export function IconButton({
  icon,
  label,
  size = 15,
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: string; label: string; size?: number }) {
  return (
    <ShadcnButton
      type="button"
      variant="ghost"
      size={children ? 'sm' : 'icon-sm'}
      title={label}
      aria-label={label}
      className={cn('text-muted hover:text-ink', className)}
      {...rest}
    >
      <Icon name={icon} size={size} />
      {children}
    </ShadcnButton>
  );
}

/** Card with an optional header row that keeps actions right-aligned. */
export function Section({
  title,
  aside,
  children,
  className = '',
  dense,
}: {
  title?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  dense?: boolean;
}) {
  return (
    <Card className={className}>
      {title ? (
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          {aside}
        </CardHeader>
      ) : null}
      <CardContent className={dense ? 'p-0' : undefined}>{children}</CardContent>
    </Card>
  );
}

export function ProgressBar({ percent, state }: { percent: number; state?: JobState }) {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  const tone =
    state === 'failed'
      ? 'bg-bad'
      : state === 'cancelled'
        ? 'bg-faint'
        : state === 'succeeded'
          ? 'bg-ok'
          : 'bg-accent';
  return (
    <Progress
      value={value}
      indicatorClassName={cn(tone, state === 'running' && 'progress-stripes')}
      aria-valuenow={value}
    />
  );
}

const STATE_VARIANT: Record<JobState, 'default' | 'ok' | 'bad' | 'outline'> = {
  queued: 'outline',
  running: 'default',
  succeeded: 'ok',
  failed: 'bad',
  cancelled: 'outline',
};

export function StateBadge({ state }: { state: JobState }) {
  const { t } = useI18n();
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-medium',
        state === 'running' && 'bg-accent-soft text-accent',
        state === 'succeeded' && 'bg-ok/12 text-ok',
        state === 'failed' && 'bg-bad/12 text-bad',
        (state === 'queued' || state === 'cancelled') && 'bg-raised text-muted',
      )}
    >
      {state === 'running' ? <Loader2 size={11} className="animate-spin" /> : null}
      {state === 'succeeded' ? <Icon name="check" size={11} /> : null}
      {state === 'failed' ? <Icon name="warning" size={11} /> : null}
      {t(`job.${state}`)}
    </span>
  );
}

export function EmptyState({
  icon = 'file',
  title,
  hint,
  action,
}: {
  icon?: string;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <span className="mb-1 flex h-11 w-11 items-center justify-center rounded-full bg-raised text-faint">
        <Icon name={icon} size={20} />
      </span>
      <p className="text-[13px] font-medium text-muted">{title}</p>
      {hint ? <p className="max-w-[320px] text-[12px] leading-relaxed text-faint">{hint}</p> : null}
      {action}
    </div>
  );
}

/** Radix Switch with the label/hint block the option forms need. */
export function Toggle({
  id,
  checked,
  onChange,
  label,
  hint,
}: {
  id?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 py-0.5">
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        className="mt-[2px]"
        aria-label={label}
      />
      <span className="min-w-0">
        <span className="block text-[13px] leading-5 text-ink">{label}</span>
        {hint ? <span className="block text-[11.5px] leading-4 text-faint">{hint}</span> : null}
      </span>
    </label>
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  size = 'md',
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
}) {
  return (
    <Tabs
      value={String(value)}
      onValueChange={(next) => {
        const match = options.find((item) => String(item.value) === next);
        if (match) onChange(match.value);
      }}
      className="w-auto"
    >
      <TabsList variant="pill" className={cn('w-fit self-start border border-line', size === 'sm' && 'p-[2px]')}>
        {options.map((option) => (
          <TabsTrigger
            key={String(option.value)}
            value={String(option.value)}
            className={size === 'sm' ? 'px-2 py-[3px] text-[12px]' : undefined}
          >
            {option.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
