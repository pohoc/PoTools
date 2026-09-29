import { isTauri } from './tauri.ts';

/**
 * Browser-mode capability limits. The desktop host is the superset: it
 * provides the privileged command surface. CJK text rendering is covered in
 * browser mode by the bundled Noto Sans SC (see lib/font-access.ts).
 */

/** Tools that cannot run at all without the desktop host. */
export const DESKTOP_ONLY_TOOLS = new Set(['invoice-organize']);

/** True when the tool cannot be opened in this browser context at all. */
export function isDesktopOnlyTool(toolId: string): boolean {
  return !isTauri() && DESKTOP_ONLY_TOOLS.has(toolId);
}

/**
 * Returns an i18n key describing why 开始处理 must stay disabled in browser
 * mode, or null when the tool can run. Desktop mode always returns null.
 */
export function browserRunBlocker(toolId: string): string | null {
  if (isTauri()) return null;
  if (DESKTOP_ONLY_TOOLS.has(toolId)) return 'run.blocked.desktopOnly';
  return null;
}
