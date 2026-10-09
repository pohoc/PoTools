/**
 * `tauri icon` 的 icns 编码是非确定性的：源图一个字节没变，重跑也会改写
 * `apps/desktop/icons/icon.icns`（并生成 android 图标），把 git 状态弄脏。
 *
 * 这个脚本按源图哈希做门禁：`app-icon.png` 真正变化时才重跑 `tauri icon`，
 * 否则跳过。哈希戳随仓库提交，克隆后的首次构建也能直接跳过。
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'apps/desktop/app-icon.png');
const stampFile = join(root, 'apps/desktop/icons/.app-icon-source-hash');

const hash = createHash('sha256').update(readFileSync(source)).digest('hex');
if (existsSync(stampFile) && readFileSync(stampFile, 'utf8').trim() === hash) {
  console.log('[icons] app-icon.png 未变化，跳过 tauri icon');
  process.exit(0);
}

console.log('[icons] app-icon.png 有变化，重新生成桌面图标...');
execSync(`pnpm --filter @potools/desktop exec tauri icon "${source}"`, {
  stdio: 'inherit',
  cwd: root,
});
writeFileSync(stampFile, `${hash}\n`);
console.log('[icons] 图标已更新，记得一并提交 icons/ 与哈希戳');
