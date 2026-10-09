/** 把 Web 构建产物同步进本包（electron 打包与 selftest 都以它为输入）。
 *  先跑 `pnpm --filter @potools/web build` 再跑本脚本；注意不要带
 *  POTOLS_WEB_TARGET=desktop——Win7 壳是浏览器模式，需要 bundled 字体与
 *  OCR 模型留在 dist 里。 */
const { cpSync, existsSync, rmSync } = require('node:fs');
const path = require('node:path');

const src = path.join(__dirname, '..', 'web', 'dist');
if (!existsSync(src)) {
  console.error('apps/web/dist 不存在：先运行 pnpm --filter @potools/web build');
  process.exit(1);
}
const dst = path.join(__dirname, 'dist');
rmSync(dst, { recursive: true, force: true });
cpSync(src, dst, { recursive: true });
console.log('[legacy-win7] dist synced');
