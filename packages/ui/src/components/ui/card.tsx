import { forwardRef } from 'react';
import { Card as HeroCard, CardHeader as HeroCardHeader, CardContent as HeroCardContent, CardFooter as HeroCardFooter } from '@heroui/react';
import { cn } from '../../utils.ts';

export const Card = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <HeroCard ref={ref} className={cn('rounded-card border border-line bg-surface text-ink shadow-card', className)} {...(props as unknown as React.ComponentProps<typeof HeroCard>)} />
));
Card.displayName = 'Card';

export const CardHeader = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <HeroCardHeader ref={ref} className={className} {...(props as unknown as React.ComponentProps<typeof HeroCardHeader>)} />
  ),
);
CardHeader.displayName = 'CardHeader';

export const CardTitle = forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h2 ref={ref} className={cn('min-w-0 flex-1 truncate text-[13.5px] font-semibold text-ink', className)} {...props} />
  ),
);
CardTitle.displayName = 'CardTitle';

export const CardDescription = forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => <p ref={ref} className={cn('text-[12px] text-muted', className)} {...props} />,
);
CardDescription.displayName = 'CardDescription';

export const CardContent = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <HeroCardContent ref={ref} className={className} {...(props as unknown as React.ComponentProps<typeof HeroCardContent>)} />,
);
CardContent.displayName = 'CardContent';

export const CardFooter = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <HeroCardFooter ref={ref} className={className} {...(props as unknown as React.ComponentProps<typeof HeroCardFooter>)} />
  ),
);
CardFooter.displayName = 'CardFooter';
