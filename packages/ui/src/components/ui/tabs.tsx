import { createContext, useContext, type ReactNode } from 'react';
import { Tabs as HeroTabs } from '@heroui/react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../utils.ts';

const Context = createContext<{ variant: TabVariant }>({ variant: 'line' });
export function Tabs({ value, defaultValue, onValueChange, children, ...props }: { value?: string; defaultValue?: string; onValueChange?: (value: string) => void; children: ReactNode; className?: string }) {
  return <HeroTabs selectedKey={value ?? defaultValue} onSelectionChange={(key) => onValueChange?.(String(key))} {...props}>{children}</HeroTabs>;
}
export const TabsContent = HeroTabs.Panel;

type TabVariant = 'line' | 'pill' | 'vertical';
const TabVariantContext = createContext<TabVariant>('line');

export function TabsTrigger({ className, variant, value, children, ...props }: { className?: string; variant?: TabVariant; value: string; children: ReactNode }) {
  const inherited = useContext(TabVariantContext);
  return <HeroTabs.Tab id={value} className={cn(tabTriggerVariants({ variant: variant ?? inherited }), className)} {...props}>{children}</HeroTabs.Tab>;
}

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
        pill: 'rounded-sm px-2.5 py-1 hover:text-ink data-[state=active]:bg-surface data-[state=active]:text-ink data-[state=active]:shadow-card',
        vertical: 'justify-start rounded-control px-2.5 py-1.5 hover:bg-raised hover:text-ink data-[state=active]:bg-accent-soft data-[state=active]:text-accent',
      },
    },
    defaultVariants: { variant: 'line' },
  },
);

export function TabsList({ className, variant, children, ...props }: { className?: string; variant?: TabVariant; children: ReactNode } & VariantProps<typeof tabListVariants>) {
  return <TabVariantContext.Provider value={variant ?? 'line'}><HeroTabs.List className={cn(tabListVariants({ variant }), className)} {...props}>{children}</HeroTabs.List></TabVariantContext.Provider>;
}

export { tabTriggerVariants };
