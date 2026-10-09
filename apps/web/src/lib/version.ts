/**
 * The build identity is generated once by `apps/web/vite.config.ts` (which
 * reads the root `package.json` as the single source of truth) and injected at
 * bundle time. Nothing here recomputes, imports or hardcodes a version.
 */
export const APP_VERSION = __APP_VERSION__;

/** 打包时间戳（vite 构建期注入，格式 MMDDHHMM，Asia/Shanghai），用于区分不同批次的应用包。 */
export const BUILD_STAMP = __BUILD_STAMP__;

/** 全部 UI/打包统一使用的完整版本串：v0.1.0-09300950 */
export const DISPLAY_VERSION = __DISPLAY_VERSION__;
