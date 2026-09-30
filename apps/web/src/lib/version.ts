/** The desktop package is the source of truth for the app version shown in UI. */
import packageJson from '../../package.json';

export const APP_VERSION = packageJson.version;

/** 打包时间戳（vite 构建期注入，格式 MMDDHHMM），用于区分不同批次的应用包。 */
export const BUILD_STAMP = __BUILD_STAMP__;

/** 全部 UI/打包统一使用的完整版本串：v0.1.0-09300934 */
export const DISPLAY_VERSION = `v${APP_VERSION}-${BUILD_STAMP}`;
