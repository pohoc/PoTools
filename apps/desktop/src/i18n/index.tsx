import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { en } from './en.ts';
import { zhCN, type MessageKey, type Messages } from './zh-CN.ts';

export type Locale = 'zh-CN' | 'en';

const TABLES: Record<Locale, Messages> = { 'zh-CN': zhCN, en };

export interface I18n {
  locale: Locale;
  t: (key: MessageKey | string, vars?: Record<string, string | number>) => string;
  tf: (key: MessageKey | string, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18n>({
  locale: 'zh-CN',
  t: (key) => key,
  tf: (key) => key,
});

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const table = TABLES[locale] ?? zhCN;

  const t = useCallback(
    (key: MessageKey | string): string => {
      const value = (table as Record<string, string>)[key];
      if (value !== undefined) return value;
      const fallback = (zhCN as Record<string, string>)[key];
      return fallback ?? key;
    },
    [table],
  );

  const tf = useCallback(
    (key: MessageKey | string, vars?: Record<string, string | number>): string =>
      interpolate(t(key), vars),
    [t],
  );

  const value = useMemo<I18n>(() => ({ locale, t, tf }), [locale, t, tf]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  return useContext(I18nContext);
}
