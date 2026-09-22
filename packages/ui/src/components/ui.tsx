import { Children, cloneElement, isValidElement, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { Button as HeroButton, Description as HeroDescription, Label as HeroLabel, Switch as HeroSwitch, Tabs as HeroTabs } from '@heroui/react';
import { Icon } from './Icon';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Progress } from './ui/progress';
import { cn } from '../utils';
export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

type Variant = 'primary' | 'default' | 'secondary' | 'ghost' | 'quiet' | 'outline' | 'danger' | 'link';

const VARIANT: Record<Variant, 'danger' | 'danger-soft' | 'ghost' | 'outline' | 'primary' | 'secondary' | 'tertiary'> = {
  primary: 'primary',
  default: 'primary',
  secondary: 'secondary',
  ghost: 'ghost',
  quiet: 'tertiary',
  outline: 'outline',
  danger: 'danger',
  link: 'tertiary',
};

/** App-level button: shadcn Button plus an icon slot and a busy state. */
export function Button({
  variant = 'ghost',
  icon,
  iconSize = 15,
  size = 'md',
  busy,
  asChild = false,
  children,
  className = '',
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  icon?: string;
  iconSize?: number;
  size?: 'sm' | 'md' | 'lg' | 'default' | 'icon' | 'icon-sm';
  busy?: boolean;
  asChild?: boolean;
}) {
  const content = <>{busy ? <Loader2 size={iconSize} className="animate-spin" /> : icon ? <Icon name={icon} size={iconSize} /> : null}{children}</>;
  const child = asChild ? Children.toArray(children)[0] : null;
  if (child && isValidElement(child)) {
    return cloneElement(child, { ...rest, className: cn(className, (child.props as { className?: string }).className) } as never);
  }
  return (
    <HeroButton
      type="button"
      variant={VARIANT[variant]}
      size={size === 'lg' ? 'lg' : size === 'sm' || size === 'icon-sm' ? 'sm' : 'md'}
      isIconOnly={size === 'icon' || size === 'icon-sm'}
      className={className}
      isDisabled={disabled || busy}
      {...(rest as unknown as React.ComponentProps<typeof HeroButton>)}
    >
      {content}
    </HeroButton>
  );
}

export function IconButton({
  icon,
  label,
  size = 15,
  className = '',
  children,
  title: _title,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: string; label: string; size?: number }) {
  return (
    <HeroButton
      type="button"
      variant="ghost"
      size="sm"
      aria-label={label}
      className={cn('text-muted hover:text-ink', className)}
      {...(rest as unknown as React.ComponentProps<typeof HeroButton>)}
    >
      <Icon name={icon} size={size} />
      {children}
    </HeroButton>
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
  const labels: Record<JobState, string> = { queued: 'Queued', running: 'Running', succeeded: 'Completed', failed: 'Failed', cancelled: 'Cancelled' };
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
      {labels[state]}
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

/**
 * HeroUI v3 switches are compound: the track only paints when Content > Control > Thumb
 * are rendered, so a bare <Switch> collapses to 0x0.
 */
function Track() {
  return (
    <HeroSwitch.Content>
      <HeroSwitch.Control>
        <HeroSwitch.Thumb />
      </HeroSwitch.Control>
    </HeroSwitch.Content>
  );
}

/** Switch on its own, for rows that carry their own label on the left. */
export function Switch({
  checked,
  onChange,
  label,
  id,
  className = '',
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  id?: string;
  className?: string;
}) {
  return (
    <HeroSwitch
      id={id}
      isSelected={checked}
      onChange={onChange}
      aria-label={label}
      size="sm"
      className={cn('shrink-0', className)}
    >
      <Track />
    </HeroSwitch>
  );
}

/** Switch with the label/hint block the option forms need. */
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
    <HeroSwitch
      id={id}
      isSelected={checked}
      onChange={onChange}
      size="sm"
      className="flex cursor-pointer flex-col gap-0.5"
    >
      <HeroSwitch.Content className="items-start">
        <HeroSwitch.Control className="mt-[2px]">
          <HeroSwitch.Thumb />
        </HeroSwitch.Control>
        <HeroLabel className="text-[13px] font-medium leading-5 text-ink">{label}</HeroLabel>
      </HeroSwitch.Content>
      {hint ? <HeroDescription className="text-[11.5px] leading-4 text-faint">{hint}</HeroDescription> : null}
    </HeroSwitch>
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
    <HeroTabs
      selectedKey={String(value)}
      onSelectionChange={(next) => {
        const match = options.find((item) => String(item.value) === next);
        if (match) onChange(match.value);
      }}
      variant="secondary"
      className="w-auto"
    >
      <HeroTabs.List className={cn('w-fit shrink-0 self-start border border-line', size === 'sm' && 'p-[2px]')}>
        {options.map((option) => (
          <HeroTabs.Tab
            key={String(option.value)}
            id={String(option.value)}
            className={cn('shrink-0 whitespace-nowrap', size === 'sm' && 'px-2 py-[3px] text-[12px]')}
          >
            {option.label}
          </HeroTabs.Tab>
        ))}
      </HeroTabs.List>
    </HeroTabs>
  );
}
