import type { ReactNode } from 'react';
import { cn } from '@potools/ui';
import { rowClass } from '../lib/rows.ts';
import { Icon } from '@potools/ui';

export function PageLayout({
  title,
  description,
  actions,
  children,
  className,
  width = 'wide',
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  width?: 'normal' | 'wide' | 'text';
}) {
  return (
    <div className={cn('page-frame mx-auto flex w-full flex-col gap-5', width === 'wide' ? 'max-w-[1180px]' : width === 'text' ? 'max-w-[900px]' : 'max-w-[1040px]', className)}>
      <header className="page-header flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[20px] font-semibold tracking-tight text-ink">{title}</h1>
          {description ? <p className="mt-1 text-[12.5px] leading-5 text-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
      </header>
      {children}
    </div>
  );
}

export function PageSection({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('app-surface min-w-0 overflow-hidden rounded-xl border border-line', className)}>
      {title || description || actions ? (
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3.5 sm:px-5">
          <div className="min-w-0">
            {title ? <h2 className="text-[14px] font-semibold text-ink">{title}</h2> : null}
            {description ? <p className="mt-1 text-[11.5px] leading-5 text-muted">{description}</p> : null}
          </div>
          {actions ? <div className="shrink-0">{actions}</div> : null}
        </div>
      ) : null}
      <div className="min-w-0 p-4 sm:p-5">{children}</div>
    </section>
  );
}

/** Shared outer shell for descriptor-driven tools. The tool supplies content; the shell owns geometry. */
export function ToolWorkspaceLayout({ header, children, width = 'wide' }: { header: ReactNode; children: ReactNode; width?: 'normal' | 'wide' | 'text' }) {
  return (
    <div className={cn('page-frame mx-auto flex w-full flex-col gap-5', width === 'wide' ? 'max-w-[1180px]' : width === 'text' ? 'max-w-[900px]' : 'max-w-[1040px]')}>
      {header}
      {children}
    </div>
  );
}

export function SettingsLayout({
  title,
  description,
  tabs,
  active,
  onChange,
  children,
}: {
  title: string;
  description?: string;
  tabs: Array<{ id: string; label: string; icon: string }>;
  active: string;
  onChange: (id: string) => void;
  children: ReactNode;
}) {
  return (
    <div className="page-frame mx-auto flex w-full max-w-[1180px] flex-col gap-5">
      <header className="page-header flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[20px] font-semibold tracking-tight text-ink">{title}</h1>
          {description ? <p className="mt-1 text-[12.5px] leading-5 text-muted">{description}</p> : null}
        </div>
      </header>
      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[204px_minmax(0,1fr)] lg:gap-5">
        <nav aria-label={title} className="min-w-0 self-start rounded-card border border-line bg-surface p-2 shadow-card lg:sticky lg:top-4">
          <div className="flex gap-1 overflow-x-auto pb-0.5 lg:flex-col lg:overflow-visible">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => onChange(tab.id)}
                aria-current={active === tab.id ? 'page' : undefined}
                className={rowClass({
                  active: active === tab.id,
                  className: 'w-auto shrink-0 text-[13px] lg:w-full',
                })}
              >
                <Icon name={tab.icon} size={16} className="shrink-0" />
                <span className="truncate">{tab.label}</span>
              </button>
            ))}
          </div>
        </nav>
        <main className="min-w-0">{children}</main>
      </div>
    </div>
  );
}
