import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Locale } from '../i18n/index.tsx';

export interface Settings {
  theme: 'system' | 'light' | 'dark';
  locale: Locale;
  outputDir: string | null;
  /** Scratch folder for staged results; null follows the OS temp folder. */
  tempDir: string | null;
  namePattern: string;
  concurrency: number;
  fontPath: string | null;
  autoOpen: boolean;
  sidebarCollapsed: boolean;
  /** Job folders older than this are swept when the engine starts. 0 = never. */
  tempTtlDays: number;
  cleanupTempOnClose: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  locale: 'zh-CN',
  outputDir: null,
  tempDir: null,
  namePattern: '{name}-{tool}',
  concurrency: 1,
  fontPath: null,
  autoOpen: false,
  sidebarCollapsed: false,
  tempTtlDays: 7,
  cleanupTempOnClose: true,
};

interface SettingsStore extends Settings {
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  reset: () => void;
}

const STORAGE_KEY = 'potools.settings';

function readStored(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as { state?: Partial<Settings> };
    return { ...DEFAULT_SETTINGS, ...(parsed.state ?? {}) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** Read before React mounts so the theme class lands without a flash. */
export function bootstrapSettings(): Settings {
  return readStored();
}

export const useSettings = create<SettingsStore>()(
  persist(
    (set) => ({
      ...readStored(),
      set: (key, value) => set({ [key]: value } as Partial<Settings>),
      reset: () => set({ ...DEFAULT_SETTINGS }),
    }),
    {
      name: STORAGE_KEY,
      partialize: ({ set: _set, reset: _reset, ...state }) => state,
    },
  ),
);
