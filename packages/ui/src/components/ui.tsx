import { Children, cloneElement, isValidElement, useRef, type ButtonHTMLAttributes, type ReactNode, type Ref } from 'react';
import { Loader2 } from 'lucide-react';
import { Button as HeroButton, Description as HeroDescription, Label as HeroLabel, Switch as HeroSwitch } from '@heroui/react';
import { Icon } from './Icon';
import { Card, CardContent, CardTitle } from './ui/card';
import { Progress } from './ui/progress';
import { cn } from '../utils';

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

/**
 * App-level button: shadcn Button plus an icon slot and a busy state.
 * HeroUI supplies the interaction model; the `.ui-button-*` classes in
 * theme/styles.css own the visuals on the package token system.
 */
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
  ref,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  icon?: string;
  iconSize?: number;
  size?: 'sm' | 'md' | 'lg' | 'default' | 'icon' | 'icon-sm';
  busy?: boolean;
  asChild?: boolean;
  ref?: Ref<HTMLButtonElement>;
}) {
  const buttonClass = cn('ui-button', `ui-button-${variant}`, `ui-button-size-${size}`, className);
  const content = <>{busy ? <Loader2 size={iconSize} className="animate-spin" /> : icon ? <Icon name={icon} size={iconSize} /> : null}{children}</>;
  const child = asChild ? Children.toArray(children)[0] : null;
  if (child && isValidElement(child)) {
    return cloneElement(child, { ...rest, className: cn(buttonClass, (child.props as { className?: string }).className) } as never);
  }
  return (
    <HeroButton
      type="button"
      variant={variant === 'outline' ? 'tertiary' : VARIANT[variant]}
      size={size === 'lg' ? 'lg' : size === 'sm' || size === 'icon-sm' ? 'sm' : 'md'}
      isIconOnly={size === 'icon' || size === 'icon-sm'}
      className={buttonClass}
      isDisabled={disabled || busy}
      ref={ref}
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
        <div className="section-header flex w-full min-w-0 items-center justify-between gap-3">
          <CardTitle className="min-w-0 flex-1">{title}</CardTitle>
          <span className="shrink-0">{aside}</span>
        </div>
      ) : null}
      <CardContent className={dense ? 'p-0' : undefined}>{children}</CardContent>
    </Card>
  );
}

/** Semantic progress coloring, decoupled from any app-specific state enum. */
export type ProgressTone = 'accent' | 'ok' | 'bad' | 'idle';

/**
 * Maps the app's semantic tones onto HeroUI's colour API, which resolves
 * `--accent`/`--success`/`--warning`/`--danger` to this app's tokens (see
 * `theme/styles.css`). `idle` uses the library's `default`, whose fill colour is
 * overridden to `--ui-faint` by the `.ui-progress` rules.
 */
const PROGRESS_COLOR: Record<ProgressTone, 'accent' | 'success' | 'danger' | 'default'> = {
  accent: 'accent',
  ok: 'success',
  bad: 'danger',
  idle: 'default',
};

export function ProgressBar({ percent, tone = 'accent', striped = false }: { percent: number; tone?: ProgressTone; striped?: boolean }) {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <Progress
      value={value}
      color={PROGRESS_COLOR[tone]}
      indicatorClassName={striped ? 'progress-stripes' : undefined}
    />
  );
}

/** Semantic badge coloring, decoupled from any app-specific state enum. */
export type BadgeTone = 'accent' | 'ok' | 'bad' | 'muted';

const BADGE_TONE: Record<BadgeTone, string> = {
  accent: 'bg-accent-soft text-accent',
  ok: 'bg-ok/12 text-ok',
  bad: 'bg-bad/12 text-bad',
  muted: 'bg-raised text-muted',
};

export function StateBadge({ tone = 'muted', icon, children }: { tone?: BadgeTone; icon?: ReactNode; children: ReactNode }) {
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-medium', BADGE_TONE[tone])}>
      {icon}
      {children}
    </span>
  );
}

export function EmptyState({
  icon = 'file',
  title,
  hint,
  action,
  className,
}: {
  icon?: string;
  title: string;
  hint?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 px-6 py-12 text-center', className)}>
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
      aria-label={label}
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
  const groupLabel = options.map((option) => option.label).join(' / ');
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Roving tabindex: only the selected tab is in the tab order, so arrow keys
  // have to move focus as well as selection. Without this the group declared
  // role="tablist"/"tab" but was unreachable by keyboard.
  const focusAndSelect = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    itemRefs.current[index]?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = options.length - 1;
    let next: number;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = index >= last ? 0 : index + 1;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = index <= 0 ? last : index - 1;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = last;
        break;
      default:
        return;
    }
    event.preventDefault();
    focusAndSelect(next);
  };

  return (
    <div
      role="tablist"
      aria-label={groupLabel}
      aria-orientation="horizontal"
      className={cn('ui-segmented', size === 'md' && 'ui-segmented-md')}
    >
      {options.map((option, index) => {
        const selected = value === option.value;
        return (
          <button
            key={String(option.value)}
            ref={(element) => {
              itemRefs.current[index] = element;
            }}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn('ui-segmented-item', selected && 'ui-segmented-item-selected', size === 'sm' && 'ui-segmented-item-sm')}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
