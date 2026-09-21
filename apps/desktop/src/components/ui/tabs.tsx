import { createContext, forwardRef, useContext } from 'react';
import * as RadixTabs from '@radix-ui/react-tabs';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils.ts';

export const Tabs = RadixTabs.Root;
export const TabsContent = RadixTabs.Content;

type TabVariant = 'line' | 'pill' | 'vertical';
const TabVariantContext = createContext<TabVariant>('line');

export const TabsTrigger = forwardRef<
  React.ElementRef<typeof RadixTabs.Trigger>,
  React.ComponentPropsWithoutRef<typeof RadixTabs.Trigger> & { variant?: TabVariant }
>(({ className, variant, ...props }, ref) => {
  const inherited = useContext(TabVariantContext);
  return (
    <RadixTabs.Trigger
      ref={ref}
      className={cn(tabTriggerVariants({ variant: variant ?? inherited }), className)}
      {...props}
    />
  );
});
TabsTrigger.displayName = 'TabsTrigger';

const tabListVariants = cva('flex items-center gap-1 outline-none', {
  variants: {
    variant: {
      line: 'border-b border-line',
      pill: 'rounded-control bg-raised/70 p-1',
      vertical: 'flex-col items-stretch gap-1',
    },
  },
  defaultVariants: { variant: 'line' },
});

const tabTriggerVariants = cva(
  'inline-flex shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap text-[12.5px] text-muted outline-none transition',
  {
    variants: {
      variant: {
        line: 'border-b-2 border-transparent px-2.5 py-1.5 hover:text-ink data-[state=active]:border-accent data-[state=active]:text-accent',
        pill: 'rounded-[7px] px-2.5 py-1 hover:text-ink data-[state=active]:bg-surface data-[state=active]:text-ink data-[state=active]:shadow-card',
        vertical: 'justify-start rounded-control px-2.5 py-1.5 hover:bg-raised hover:text-ink data-[state=active]:bg-accent-soft data-[state=active]:text-accent',
      },
    },
    defaultVariants: { variant: 'line' },
  },
);

export const TabsList = forwardRef<
  React.ElementRef<typeof RadixTabs.List>,
  React.ComponentPropsWithoutRef<typeof RadixTabs.List> & VariantProps<typeof tabListVariants>
>(({ className, variant, ...props }, ref) => (
  <TabVariantContext.Provider value={variant ?? 'line'}>
    <RadixTabs.List ref={ref} className={cn(tabListVariants({ variant }), className)} {...props} />
  </TabVariantContext.Provider>
));
TabsList.displayName = 'TabsList';

export { tabTriggerVariants };
