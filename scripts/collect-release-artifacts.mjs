import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const platform = process.argv[2];
const architecture = process.argv[3];
const outputs = {
  macos: {
    label: 'macOS',
    source: 'apps/desktop/src-tauri/target/x86_64-apple-darwin/release/bundle/dmg',
    destination: 'release/macOS',
    pattern: /^PoTools_.*\.dmg$/,
  },
  windows: {
    label: 'Windows',
    destination: 'release/Windows',
    files: {
      x64: [
        `apps/desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/PoTools_${version}_x64-setup.exe`,
        `apps/desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/PoTools_${version}_windows_x64-portable.zip`,
      ],
      x86: [
        `apps/desktop/src-tauri/target/i686-pc-windows-msvc/release/bundle/nsis/PoTools_${version}_x86-setup.exe`,
        `apps/desktop/src-tauri/target/i686-pc-windows-msvc/release/bundle/PoTools_${version}_windows_x86-portable.zip`,
      ],
    },
  },
  linux: {
    label: 'Linux',
    destination: 'release/Linux',
    bundleRoots: {
      x64: 'apps/desktop/src-tauri/target/x86_64-unknown-linux-gnu/release/bundle',
      arm64: 'apps/desktop/src-tauri/target/aarch64-unknown-linux-gnu/release/bundle',
      armv7: 'apps/desktop/src-tauri/target/armv7-unknown-linux-gnueabihf/release/bundle',
      ppc64le: 'apps/desktop/src-tauri/target/powerpc64le-unknown-linux-gnu/release/bundle',
      s390x: 'apps/desktop/src-tauri/target/s390x-unknown-linux-gnu/release/bundle',
    },
    formats: {
      x64: ['appimage', 'deb', 'rpm'],
      arm64: ['appimage', 'deb', 'rpm'],
      armv7: ['deb', 'rpm'],
      ppc64le: ['deb', 'rpm'],
      s390x: ['deb', 'rpm'],
    },
  },
};

const config = outputs[platform];
if (!config || ((platform === 'windows' || platform === 'linux') && architecture && !(config.files ?? config.bundleRoots)[architecture])) {
  throw new Error('Usage: node scripts/collect-release-artifacts.mjs <macos|windows|linux> [x64|x86|arm64|armv7|ppc64le|s390x]');
}

const destination = path.join(root, config.destination);
if (platform === 'macos' || !architecture) await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });

if (platform === 'macos') {
  const source = path.join(root, config.source);
  const dmg = (await readdir(source)).find((name) => config.pattern.test(name));
  if (!dmg) throw new Error(`No macOS DMG found in ${source}`);
  await cp(path.join(source, dmg), path.join(destination, dmg));
  console.log(`[release] copied ${dmg} to ${destination}`);
} else if (platform === 'windows') {
  const files = architecture ? config.files[architecture] : Object.values(config.files).flat();
  for (const relative of files) {
    const source = path.join(root, relative);
    await cp(source, path.join(destination, path.basename(source)));
  }
  await writeFile(
    path.join(destination, '说明.txt'),
    'Windows 安装版与绿色版均包含 x64 和 x86 两种架构。绿色版首次启动时会检查 WebView2；如缺少则自动从微软下载并安装，需要网络连接。\r\n',
    'utf8',
  );
  console.log(`[release] copied ${architecture ?? 'x64 and x86'} Windows installers and portable archives to ${destination}`);
} else {
  const architectures = architecture ? [architecture] : Object.keys(config.bundleRoots);
  const extensionForFormat = { appimage: '.AppImage', deb: '.deb', rpm: '.rpm' };
  for (const arch of architectures) {
    const bundleRoot = path.join(root, config.bundleRoots[arch]);
    let copied = 0;
    const formats = config.formats[arch];
    for (const format of formats) {
      const source = path.join(bundleRoot, format);
      let entries;
      try {
        entries = await readdir(source, { withFileTypes: true });
      } catch {
        throw new Error(`Missing Linux ${arch} ${format} bundle directory: ${source}`);
      }
      for (const entry of entries) {
        if (!entry.isFile() || path.extname(entry.name) !== extensionForFormat[format]) continue;
        await cp(path.join(source, entry.name), path.join(destination, entry.name));
        copied += 1;
      }
    }
    if (copied !== formats.length) throw new Error(`Expected ${formats.join(', ')} outputs for Linux ${arch}; copied ${copied}.`);
  }
  await writeFile(
    path.join(destination, '说明.txt'),
    '当前 Linux 构建配置覆盖 x64、ARM64、ARMv7 hard-float、PowerPC64 LE 和 IBM Z（s390x），兼容性需按目标发行版版本验收。x64/ARM64 配置 AppImage、DEB、RPM；其他架构配置 DEB、RPM。程序运行依赖目标系统的 WebKitGTK 4.1；ARMv7/PowerPC64 LE/IBM Z 的 OCR 使用 WebAssembly，Sharp 运行库要求 glibc 2.36 或更新版本。\r\n',
    'utf8',
  );
  console.log(`[release] copied Linux ${architectures.join(' and ')} packages to ${destination}`);
}
