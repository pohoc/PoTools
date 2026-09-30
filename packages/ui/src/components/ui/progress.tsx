import { ProgressBar } from '@heroui/react';
import { cn } from '../../utils.ts';

/**
 * Determinate progress bar.
 *
 * KNOWN GAP: `indicatorClassName` currently has no effect, because HeroUI v3's
 * `ProgressBar` root renders no track and no fill of its own — its stylesheet
 * only targets `.progress-bar__track` / `.progress-bar__fill` children, and the
 * root is a grid (`grid-template-areas: "label output" / "track track"`). The
 * bar therefore paints an empty `bg-raised` track and never advances, and the
 * `accent`/`ok`/`bad`/`idle` tones passed by `ProgressBar` are unreachable.
 *
 * Fixing it means composing the library's own parts so the grid areas line up:
 *   <ProgressBar.Track><ProgressBar.Fill className={indicatorClassName} /></ProgressBar.Track>
 * and then reconciling HeroUI's `--progress-bar-fill` / `--default` theme
 * variables with this app's token colours. That is a visual change, so it is
 * left for a deliberate design pass rather than being guessed at here.
 */
export function Progress({
  className,
  value = 0,
  indicatorClassName: _indicatorClassName,
  ...props
}: React.ComponentProps<typeof ProgressBar> & { indicatorClassName?: string }) {
  return (
    <ProgressBar
      className={cn('relative h-1.5 w-full overflow-hidden rounded-full bg-raised', className)}
      value={value}
      {...props}
    />
  );
}
