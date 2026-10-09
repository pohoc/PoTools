/**
 * 自动更新（tauri-plugin-updater）的前端封装。
 *
 * 仅桌面版可用：更新签名走 Tauri updater（minisign），安装包由 Release 提供
 * latest.json 索引。浏览器模式没有宿主，`checkForUpdate` 直接抛 unsupported。
 */
import { useCallback, useState } from 'react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { isTauri } from './tauri.ts';

/** 启动静默检查的节流间隔：GitHub 端点没必要每次启动都打。 */
const CHECK_THROTTLE_MS = 6 * 60 * 60 * 1000;
const CHECKED_AT_KEY = 'potools.update.checkedAt';

/** 是否到了该自动检查的时间（启动检查与关于页自检共用这个节流阀）。 */
export function shouldAutoCheck(): boolean {
  try {
    const last = Number(localStorage.getItem(CHECKED_AT_KEY) ?? 0);
    return !(Number.isFinite(last) && Date.now() - last < CHECK_THROTTLE_MS);
  } catch {
    return true;
  }
}

export type UpdaterPhase =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'upToDate' }
  | { kind: 'available'; version: string; notes?: string }
  | { kind: 'downloading'; received: number; total: number | null }
  | { kind: 'ready' }
  | { kind: 'error'; message: string };

export interface Updater {
  phase: UpdaterPhase;
  /** 检查并在发现新版本时自动下载，完成后进入 `ready`（等用户点重启）。 */
  run: () => Promise<void>;
  relaunch: () => void;
}

export function useUpdater(): Updater {
  const [phase, setPhase] = useState<UpdaterPhase>({ kind: 'idle' });

  const run = useCallback(async (): Promise<void> => {
    if (!isTauri()) {
      setPhase({ kind: 'error', message: '此功能需要 PoTools 桌面版' });
      return;
    }
    try {
      setPhase({ kind: 'checking' });
      const update: Update | null = await check();
      if (!update) {
        setPhase({ kind: 'upToDate' });
        markChecked();
        return;
      }
      setPhase({ kind: 'available', version: update.version, notes: update.body ?? undefined });
      let received = 0;
      let total: number | null = null;
      setPhase({ kind: 'downloading', received: 0, total: null });
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          total = event.data.contentLength ?? null;
          setPhase({ kind: 'downloading', received: 0, total });
        } else if (event.event === 'Progress') {
          received += event.data.chunkLength;
          setPhase({ kind: 'downloading', received, total });
        } else {
          setPhase({ kind: 'downloading', received: total ?? received, total });
        }
      });
      markChecked();
      setPhase({ kind: 'ready' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 插件在端点 404 / 清单缺失时抛这句话——对用户来说等价于"没有可用更新"
      // （首版发布前 latest.json 尚不存在是常态），其余错误才如实展示。
      if (message.includes('Could not fetch a valid release JSON')) {
        markChecked();
        setPhase({ kind: 'upToDate' });
        return;
      }
      setPhase({ kind: 'error', message });
    }
  }, []);

  const relaunchNow = useCallback((): void => {
    void relaunch();
  }, []);

  return { phase, run, relaunch: relaunchNow };
}

/** 启动时的静默检查：节流到 6 小时一次，命中新版本只写一条日志提示。 */
/** 启动静默检查：节流与关于页自检共用（shouldAutoCheck），命中只写日志面板。 */
export async function startupUpdateCheck(): Promise<void> {
  if (!isTauri()) return;
  if (!shouldAutoCheck()) return;
  try {
    const update = await check();
    markChecked();
    if (update) {
      console.info(`发现新版本 v${update.version}：设置 → 关于 → 检查更新 可下载安装`);
    }
  } catch (error) {
    // 静默检查失败不打扰用户（离线/网络差是常态），留给日志面板。
    console.debug('更新检查失败', error);
  }
}

function markChecked(): void {
  try {
    localStorage.setItem(CHECKED_AT_KEY, String(Date.now()));
  } catch {
    // localStorage 不可用时静默跳过节流。
  }
}
