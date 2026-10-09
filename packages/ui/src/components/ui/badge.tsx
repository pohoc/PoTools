import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../utils.ts';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11.5px] font-medium leading-4 whitespace-nowrap',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-accent-soft text-accent',
        outline: 'border-line bg-surface text-muted',
        ok: 'border-transparent bg-ok/12 text-ok',
        warn: 'border-transparent bg-warn/12 text-warn',
        bad: 'border-transparent bg-bad/12 text-bad',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export function Badge({ className, variant, ...props }: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
