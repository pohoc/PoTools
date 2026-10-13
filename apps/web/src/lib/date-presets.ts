/**
 * Mirrors the engine's relative-phrase resolution (engine tools/text/common.rs)
 * so a preset chip echoes the datetime it stands for instead of the raw
 * identifier. The stored value stays the identifier — the engine resolves it
 * against the tool's timezone and keeps it relative.
 */
export function resolveDatePreset(preset: string, now = new Date()): string | null {
  const pad = (part: number): string => String(part).padStart(2, '0');
  const stamp = (date: Date): string =>
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const midnight = (offsetDays = 0): Date => {
    const date = new Date(now);
    date.setDate(date.getDate() + offsetDays);
    date.setHours(0, 0, 0, 0);
    return date;
  };
  switch (preset) {
    case 'now': return stamp(now);
    case 'today': return stamp(midnight());
    case 'yesterday': return stamp(midnight(-1));
    case 'tomorrow': return stamp(midnight(1));
    case 'week-start': return stamp(midnight(-((now.getDay() + 6) % 7)));
    case 'month-start': return stamp(new Date(now.getFullYear(), now.getMonth(), 1));
    case 'quarter-start': return stamp(new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1));
    case 'year-start': return stamp(new Date(now.getFullYear(), 0, 1));
    default: return null;
  }
}
