import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';

type ThemeContextValue = {
  mode: ThemeMode;
  resolvedMode: 'light' | 'dark';
  setMode: (mode: ThemeMode) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function resolveMode(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'system') return mode;
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function ThemeProvider({
  children,
  defaultMode = 'system',
  storageKey = 'potools.ui.theme',
}: {
  children: ReactNode;
  defaultMode?: ThemeMode;
  storageKey?: string;
}) {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    try {
      return (localStorage.getItem(storageKey) as ThemeMode | null) ?? defaultMode;
    } catch {
      return defaultMode;
    }
  });
  const [resolvedMode, setResolvedMode] = useState(() => resolveMode(mode));

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const update = () => setResolvedMode(resolveMode(mode));
    update();
    if (mode !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [mode]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.classList.toggle('dark', resolvedMode === 'dark');
    document.documentElement.style.colorScheme = resolvedMode;
  }, [resolvedMode]);

  const value = useMemo<ThemeContextValue>(() => ({
    mode,
    resolvedMode,
    setMode: (next) => {
      setModeState(next);
      try { localStorage.setItem(storageKey, next); } catch { /* storage is optional */ }
    },
  }), [mode, resolvedMode, storageKey]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside ThemeProvider');
  return context;
}
