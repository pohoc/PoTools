import { cn } from '@potools/ui';

/** Shared geometry for navigable rows: sidebar rail and settings navigation. */
export const ROW_BASE =
  'relative flex h-10 w-full cursor-pointer items-center gap-3 rounded-control px-3 text-[12.5px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent';

export const rowTone = (active: boolean) =>
  active ? 'bg-accent-soft font-medium text-accent' : 'text-muted hover:bg-raised hover:text-ink';

export function rowClass(opts: { active?: boolean; rail?: boolean; className?: string } = {}) {
  const { active = false, rail = false, className } = opts;
  return cn(ROW_BASE, rail && 'justify-center px-0', rowTone(active), className);
}
