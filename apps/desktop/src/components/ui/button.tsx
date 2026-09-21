import { forwardRef } from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils.ts';

const buttonVariants = cva(
  'inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-control border text-[13px] font-medium transition active:translate-y-[0.5px] outline-none focus-visible:ring-2 focus-visible:ring-accent/35 disabled:pointer-events-none disabled:opacity-45',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-accent text-accent-ink hover:brightness-[1.06]',
        secondary: 'border-line bg-surface text-ink hover:bg-raised',
        ghost: 'border-transparent bg-transparent text-muted hover:bg-raised hover:text-ink',
        outline: 'border-line bg-transparent text-ink hover:bg-raised',
        danger: 'border-transparent bg-bad/10 text-bad hover:bg-bad/20',
        link: 'border-transparent bg-transparent text-accent underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-8 px-3',
        sm: 'h-7 px-2.5 text-[12.5px]',
        lg: 'h-10 px-4 text-[13.5px]',
        icon: 'h-8 w-8 p-0',
        'icon-sm': 'h-7 w-7 p-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
  },
);
Button.displayName = 'Button';

export { buttonVariants };
