import { ProgressBar } from '@heroui/react';
import { cn } from '../../utils.ts';

/**
 * Determinate progress bar.
 *
 * HeroUI's `ProgressBar` root renders no track and no fill of its own: its
 * stylesheet targets the `.progress-bar__track` / `.progress-bar__fill`
 * children, and the root is a grid whose `track` area those children occupy.
 * Passing only `indicatorClassName` (as this wrapper used to) therefore painted
 * an empty `bg-raised` box that never advanced, and made every tone unreachable.
 *
 * The library keeps the ARIA state machine, the grid layout and the animated
 * width; the track surface, corner radius and tone colours come from this app's
 * tokens through the `.ui-progress` rules in `theme/styles.css`.
 */
export function Progress({
  className,
  value = 0,
  indicatorClassName,
  ...props
}: React.ComponentProps<typeof ProgressBar> & { indicatorClassName?: string }) {
  return (
    <ProgressBar className={cn('ui-progress w-full', className)} value={value} {...props}>
      <ProgressBar.Track>
        <ProgressBar.Fill className={indicatorClassName} />
      </ProgressBar.Track>
    </ProgressBar>
  );
}
