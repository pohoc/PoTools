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

const isString = (value: unknown): boolean => typeof value === 'string';
const isBoolean = (value: unknown): boolean => typeof value === 'boolean';
const isNullableString = (value: unknown): boolean => value === null || typeof value === 'string';
const isTheme = (value: unknown): boolean => value === 'system' || value === 'light' || value === 'dark';
const isLocale = (value: unknown): boolean => value === 'zh-CN' || value === 'en';
const isIntegerBetween = (min: number, max: number) => (value: unknown): boolean =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

/**
 * Validates a persisted settings blob field by field.
 *
 * `localStorage` is writable by anything running in the page, and an older build
 * or a hand edit can leave a blob with the right keys but the wrong types. The
 * previous implementation spread `parsed.state` straight into the store, so a
 * corrupted `locale`, `concurrency` or `theme` reached the UI unchecked. Invalid
 * values now fall back to the default for that field only, so one bad entry does
 * not discard the rest of the user's preferences.
 */
function sanitizeSettings(raw: unknown): Settings {
  const source: Record<string, unknown> =
    raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const read = <K extends keyof Settings>(key: K, valid: (value: unknown) => boolean): Settings[K] =>
    valid(source[key]) ? (source[key] as Settings[K]) : DEFAULT_SETTINGS[key];

  return {
    theme: read('theme', isTheme),
    locale: read('locale', isLocale),
    outputDir: read('outputDir', isNullableString),
    tempDir: read('tempDir', isNullableString),
    namePattern: read('namePattern', isString),
    // The settings UI offers 1-4 and the worker pool caps at 4 regardless.
    concurrency: read('concurrency', isIntegerBetween(1, 4)),
    fontPath: read('fontPath', isNullableString),
    autoOpen: read('autoOpen', isBoolean),
    sidebarCollapsed: read('sidebarCollapsed', isBoolean),
    // 0 means "never sweep"; the upper bound only guards against absurd values.
    tempTtlDays: read('tempTtlDays', isIntegerBetween(0, 3650)),
    cleanupTempOnClose: read('cleanupTempOnClose', isBoolean),
  };
}

function readStored(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as { state?: unknown };
    return sanitizeSettings(parsed?.state);
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
