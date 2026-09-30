import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILD_INFO_FILENAME, buildStamp, displayVersion } from './build-stamp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version: manifestVersion } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

/**
 * Prefer the identity the web build actually embedded, so the artifact name and
 * the in-app `DISPLAY_VERSION` cannot disagree. The Tauri `beforeBuildCommand`
 * always runs that build first, so a missing file means packaging was invoked
 * without it.
 */
async function readBuildInfo() {
  const file = path.join(root, 'apps/web/dist', BUILD_INFO_FILENAME);
  try {
    const info = JSON.parse(await readFile(file, 'utf8'));
    if (typeof info.version !== 'string' || typeof info.buildStamp !== 'string') {
      throw new Error('missing version/buildStamp');
    }
    return { ...info, source: 'apps/web/dist/build-info.json' };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error(`Invalid ${file}: ${error.message}`);
    const stamp = buildStamp();
    console.warn(`[release] ${file} not found; falling back to root package.json + a freshly computed stamp.`);
    return {
      version: manifestVersion,
      buildStamp: stamp,
      displayVersion: displayVersion(manifestVersion, stamp),
      source: 'root package.json (fallback)',
    };
  }
}

const buildInfo = await readBuildInfo();
const version = buildInfo.version;
if (version !== manifestVersion) {
  throw new Error(
    `Version mismatch: root package.json is ${manifestVersion} but the web build embedded ${version}. ` +
      'Run `pnpm version:sync` and rebuild before packaging.',
  );
}
console.log(`[release] build identity ${buildInfo.displayVersion} (from ${buildInfo.source})`);

const platform = process.argv[2];
const architecture = process.argv[3];
const outputs = {
  macos: {
    label: 'macOS',
    source: 'apps/desktop/target/x86_64-apple-darwin/release/bundle/dmg',
    destination: 'release/macOS',
    pattern: /^PoTools_.*\.dmg$/,
  },
  windows: {
    label: 'Windows',
    destination: 'release/Windows',
    files: {
      x64: [
        `apps/desktop/target/x86_64-pc-windows-msvc/release/bundle/nsis/PoTools_${version}_x64-setup.exe`,
      ],
      x86: [
        `apps/desktop/target/i686-pc-windows-msvc/release/bundle/nsis/PoTools_${version}_x86-setup.exe`,
      ],
    },
  },
  linux: {
    label: 'Linux',
    destination: 'release/Linux',
    bundleRoots: {
      x64: 'apps/desktop/target/x86_64-unknown-linux-gnu/release/bundle',
      arm64: 'apps/desktop/target/aarch64-unknown-linux-gnu/release/bundle',
      armv7: 'apps/desktop/target/armv7-unknown-linux-gnueabihf/release/bundle',
      ppc64le: 'apps/desktop/target/powerpc64le-unknown-linux-gnu/release/bundle',
      s390x: 'apps/desktop/target/s390x-unknown-linux-gnu/release/bundle',
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
  // The DMG comes from Tauri as PoTools_<version>_<arch>.dmg; fail loudly if the
  // bundle version drifted from the synced manifests instead of mislabelling it.
  const bundled = /^PoTools_([0-9][^-]*?)(_[a-z0-9]+)?\.dmg$/.exec(dmg)?.[1];
  if (bundled !== version) {
    throw new Error(`DMG ${dmg} carries version ${bundled ?? '(unreadable)'} but the build identity is ${version}. Run \`pnpm version:sync\` and rebuild.`);
  }
  const stamped = dmg.replace(/^(PoTools_[0-9.]+?)(_[a-z0-9]+)?\.dmg$/, `$1-${buildInfo.buildStamp}$2.dmg`);
  await cp(path.join(source, dmg), path.join(destination, stamped));
  console.log(`[release] copied ${stamped} to ${destination}`);
} else if (platform === 'windows') {
  const files = architecture ? config.files[architecture] : Object.values(config.files).flat();
  for (const relative of files) {
    const source = path.join(root, relative);
    await cp(source, path.join(destination, path.basename(source)));
  }
  await writeFile(
    path.join(destination, '说明.txt'),
    'Windows 安装版包含 x64 和 x86 两种架构。安装包不含 Node 运行时或任何旁置引擎文件：所有工具内建于应用并在本机运行。首次启动时会检查 WebView2；如缺少则自动从微软下载并安装，需要网络连接。\r\n',
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
    '当前 Linux 构建配置覆盖 x64、ARM64、ARMv7 hard-float、PowerPC64 LE 和 IBM Z（s390x），兼容性需按目标发行版版本验收。x64/ARM64 配置 AppImage、DEB、RPM；其他架构配置 DEB、RPM。程序运行依赖目标系统的 WebKitGTK 4.1。安装包不含 Node 运行时或任何旁置引擎文件：OCR 与图像处理内建于应用并在本机运行。\r\n',
    'utf8',
  );
  console.log(`[release] copied Linux ${architectures.join(' and ')} packages to ${destination}`);
}
