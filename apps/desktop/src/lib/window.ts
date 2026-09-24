import { getCurrentWindow } from '@tauri-apps/api/window';
import { isTauri } from './tauri.ts';

export type Platform = 'macos' | 'windows' | 'linux' | 'web';

/** The webview UA is enough here; the OS plugin would be a second dependency. */
export function platform(): Platform {
  if (!isTauri()) return 'web';
  const ua = navigator.userAgent;
  if (/Macintosh|Mac OS X/i.test(ua)) return 'macos';
  if (/Windows/i.test(ua)) return 'windows';
  return 'linux';
}

export const isMac = (): boolean => platform() === 'macos';

/** macOS keeps its native traffic lights, so only Windows/Linux draw buttons. */
export const usesCustomWindowButtons = (): boolean => {
  const current = platform();
  return current === 'windows' || current === 'linux';
};

async function win(): Promise<ReturnType<typeof getCurrentWindow> | null> {
  if (!isTauri()) return null;
  return getCurrentWindow();
}

export async function minimizeWindow(): Promise<void> {
  await (await win())?.minimize();
}

export async function toggleMaximize(): Promise<void> {
  await (await win())?.toggleMaximize();
}

/** Hands the window to the OS for an interactive move. */
export async function startWindowDrag(): Promise<void> {
  await (await win())?.startDragging();
}

export async function closeWindow(): Promise<void> {
  try {
    await (await win())?.close();
  } catch (error) {
    // The close request can outlive the native webview during Windows exit.
    // At that point the requested outcome (a closed window) is already met.
    console.debug('PoTools window close completed during native teardown', error);
  }
}

export async function isMaximized(): Promise<boolean> {
  const target = await win();
  return target ? target.isMaximized() : false;
}

/** Resizes arrive on every maximize/restore, which is what the button icon needs. */
export function watchMaximized(handler: (maximized: boolean) => void): () => void {
  let disposed = false;
  const unlisten = Promise.resolve().then(async () => {
    const target = await win();
    if (!target || disposed) return undefined;
    try {
      handler(await target.isMaximized());
      if (disposed) return undefined;
      return await target.onResized(async () => {
        if (disposed) return;
        try {
          handler(await target.isMaximized());
        } catch {
          // The native window may already be closing while its final resize
          // event is being delivered. There is no UI state left to update.
        }
      });
    } catch {
      // Window setup can race with app shutdown (notably on Windows). This
      // listener only drives a decorative button state, so a destroyed window
      // is equivalent to having no listener.
      return undefined;
    }
  }).catch(() => undefined);
  return () => {
    disposed = true;
    void unlisten.then((stop) => {
      try {
        stop?.();
      } catch {
        // Tauri may have already removed listeners as the webview is destroyed.
      }
    });
  };
}
