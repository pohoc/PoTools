import { Loader2 } from 'lucide-react';
import { cn } from '../../utils';

export function Spinner({ className, size = 16 }: { className?: string; size?: number }) {
  return <Loader2 aria-label="Loading" role="status" size={size} className={cn('animate-spin text-muted', className)} />;
}

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden="true" className={cn('animate-pulse rounded-control bg-raised', className)} {...props} />;
}
