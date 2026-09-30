import { ProgressBar } from '@heroui/react';
import { cn } from '../../utils.ts';

/**
 * Determinate progress bar.
 *
 * HeroUI v3's `ProgressBar` root is a bare react-aria `ProgressBar`: it renders
 * no track and no fill of its own, and its stylesheet only targets
 * `.progress-bar__track` / `.progress-bar__fill` children. The previous version
 * passed `indicatorClassName` and never rendered anything to attach it to, so
 * every bar in the app drew an empty track and never advanced — the tone colours
 * (`accent`/`ok`/`bad`/`idle`) and the striped variant were unreachable.
 *
 * The fill is rendered here (rather than via `ProgressBar.Track`/`ProgressBar.Fill`)
 * so the bar keeps the app's own token-based colours instead of HeroUI's
 * `--default`/`--progress-bar-fill` theme variables.
 */
export function Progress({
  className,
  value = 0,
  indicatorClassName,
  ...props
}: React.ComponentProps<typeof ProgressBar> & { indicatorClassName?: string }) {
  const percent = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <ProgressBar
      className={cn('relative h-1.5 w-full overflow-hidden rounded-full bg-raised', className)}
      value={value}
      {...props}
    >
      <div
        data-slot="progress-fill"
        className={cn(
          'h-full rounded-full transition-[width] duration-300 ease-out motion-reduce:transition-none',
          indicatorClassName,
        )}
        style={{ width: `${percent}%` }}
      />
    </ProgressBar>
  );
}
