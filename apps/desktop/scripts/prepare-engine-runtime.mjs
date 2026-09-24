import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { chmod, cp, mkdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const platform = process.env.TAURI_ENV_PLATFORM;
const arch = process.env.TAURI_ENV_ARCH;
const targetPlatform = platform === 'darwin' ? 'macos' : platform;
const isWindowsX86 = targetPlatform === 'windows' && ['x86', 'i686', 'ia32'].includes(arch);
const engineRoot = fileURLToPath(new URL('../../../packages/engine/', import.meta.url));
const engineDist = join(engineRoot, 'dist');

const WINDOWS_NODE = isWindowsX86
  ? { version: 'v20.20.2', file: 'win-x86/node.exe', sha256: '33379026333558256e5f467d80c67ba20f6b8e77e8d3ab72ad4dc005f6e11845', license: 'Node.js-20.20.2.txt' }
  : { version: 'v22.20.0', file: 'win-x64/node.exe', sha256: 'fdddbf4581e046b8102815d56208d6a248950bb554570b81519a8a5dacfee95d', license: 'Node.js-22.20.0.txt' };

async function hasSha256(path, expected) {
  try {
    const hash = createHash('sha256').update(await readFile(path)).digest('hex');
    return hash === expected;
  } catch {
    return false;
  }
}

async function prepareWindowsNode() {
  if (!['x86_64', 'x86', 'i686', 'ia32'].includes(arch)) {
    throw new Error(`Bundled Windows Node runtime is not available for ${arch ?? 'unknown architecture'}`);
  }
  const { version, file, sha256 } = WINDOWS_NODE;
  const destination = join(engineDist, 'node.exe');
  const temporary = `${destination}.download`;
  if (await hasSha256(destination, sha256)) {
    console.log(`[engine-runtime] using verified Node ${version} for Windows ${isWindowsX86 ? 'x86' : 'x64'}`);
    return;
  }
  await mkdir(dirname(destination), { recursive: true });
  await rm(temporary, { force: true });
  const urls = [
    `https://cdn.npmmirror.com/binaries/node/${version}/${file}`,
    `https://nodejs.org/dist/${version}/${file}`,
  ];
  let lastError;
  for (const url of urls) {
    try {
      console.log(`[engine-runtime] downloading Node ${version} for Windows ${isWindowsX86 ? 'x86' : 'x64'}`);
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} from ${url}`);
      await pipeline(response.body, createWriteStream(temporary));
      if (!(await hasSha256(temporary, sha256))) throw new Error(`SHA-256 mismatch for ${url}`);
      await rename(temporary, destination);
      console.log(`[engine-runtime] verified Windows Node runtime at ${destination}`);
      return;
    } catch (error) {
      lastError = error;
      await rm(temporary, { force: true });
    }
  }
  throw new Error(`Unable to prepare the bundled Windows Node runtime: ${lastError}`);
}

async function prepareMacNode() {
  if (arch !== 'x86_64') {
    throw new Error(`Bundled macOS Node runtime is not available for ${arch ?? 'unknown architecture'}`);
  }
  const version = 'v22.20.0';
  const archiveName = `node-${version}-darwin-x64.tar.gz`;
  const destination = join(engineDist, 'node');
  const manifestUrls = [
    `https://nodejs.org/dist/${version}/SHASUMS256.txt`,
    `https://cdn.npmmirror.com/binaries/node/${version}/SHASUMS256.txt`,
  ];
  let expectedHash;
  let manifestError;
  for (const url of manifestUrls) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
      const entry = (await response.text()).split(/\r?\n/).find((line) => line.trim().endsWith(` ${archiveName}`));
      expectedHash = entry?.split(/\s+/)[0];
      if (!expectedHash) throw new Error(`SHA-256 entry for ${archiveName} is missing`);
      break;
    } catch (error) {
      manifestError = error;
    }
  }
  if (!expectedHash) throw new Error(`Unable to read the official Node checksum: ${manifestError}`);
  if (await hasSha256(destination, expectedHash)) {
    console.log(`[engine-runtime] using verified Node ${version} for macOS x64`);
    return;
  }

  const tempRoot = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'potools-node-')));
  const archivePath = join(tempRoot, archiveName);
  const urls = [
    `https://cdn.npmmirror.com/binaries/node/${version}/${archiveName}`,
    `https://nodejs.org/dist/${version}/${archiveName}`,
  ];
  let lastError;
  try {
    for (const url of urls) {
      try {
        console.log(`[engine-runtime] downloading Node ${version} for macOS x64`);
        const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} from ${url}`);
        await pipeline(response.body, createWriteStream(archivePath));
        if (!(await hasSha256(archivePath, expectedHash))) throw new Error(`SHA-256 mismatch for ${url}`);
        execFileSync('tar', ['-xzf', archivePath, '-C', tempRoot, '--strip-components=2', `${archiveName.slice(0, -7)}/bin/node`]);
        await mkdir(dirname(destination), { recursive: true });
        await rename(join(tempRoot, 'node'), destination);
        await chmod(destination, 0o755);
        console.log(`[engine-runtime] verified macOS Node runtime at ${destination}`);
        return;
      } catch (error) {
        lastError = error;
        await rm(archivePath, { force: true });
      }
    }
    throw new Error(`Unable to prepare the bundled macOS Node runtime: ${lastError}`);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function prepareLinuxNode() {
  const nodeArch = {
    x86_64: 'x64',
    aarch64: 'arm64',
    armv7: 'armv7l',
    powerpc64le: 'ppc64le',
    s390x: 's390x',
  }[arch];
  if (!nodeArch) throw new Error(`Bundled Linux Node runtime is not available for ${arch ?? 'unknown architecture'}`);
  const version = 'v22.20.0';
  const archiveName = `node-${version}-linux-${nodeArch}.tar.gz`;
  const destination = join(engineDist, 'node');
  const manifestUrls = [
    `https://nodejs.org/dist/${version}/SHASUMS256.txt`,
    `https://cdn.npmmirror.com/binaries/node/${version}/SHASUMS256.txt`,
  ];
  let expectedHash;
  let manifestError;
  for (const url of manifestUrls) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
      const entry = (await response.text()).split(/\r?\n/).find((line) => line.trim().endsWith(` ${archiveName}`));
      expectedHash = entry?.split(/\s+/)[0];
      if (!expectedHash) throw new Error(`SHA-256 entry for ${archiveName} is missing`);
      break;
    } catch (error) {
      manifestError = error;
    }
  }
  if (!expectedHash) throw new Error(`Unable to read the official Node checksum: ${manifestError}`);
  if (await hasSha256(destination, expectedHash)) {
    console.log(`[engine-runtime] using verified Node ${version} for Linux ${nodeArch}`);
    return;
  }

  const tempRoot = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'potools-node-')));
  const archivePath = join(tempRoot, archiveName);
  const urls = [
    `https://cdn.npmmirror.com/binaries/node/${version}/${archiveName}`,
    `https://nodejs.org/dist/${version}/${archiveName}`,
  ];
  let lastError;
  try {
    for (const url of urls) {
      try {
        console.log(`[engine-runtime] downloading Node ${version} for Linux ${nodeArch}`);
        const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} from ${url}`);
        await pipeline(response.body, createWriteStream(archivePath));
        if (!(await hasSha256(archivePath, expectedHash))) throw new Error(`SHA-256 mismatch for ${url}`);
        execFileSync('tar', ['-xzf', archivePath, '-C', tempRoot, '--strip-components=2', `${archiveName.slice(0, -7)}/bin/node`]);
        await mkdir(dirname(destination), { recursive: true });
        await rename(join(tempRoot, 'node'), destination);
        await chmod(destination, 0o755);
        console.log(`[engine-runtime] verified Linux Node runtime at ${destination}`);
        return;
      } catch (error) {
        lastError = error;
        await rm(archivePath, { force: true });
      }
    }
    throw new Error(`Unable to prepare the bundled Linux Node runtime: ${lastError}`);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function installedPackagePath(packageName, parentPackage = null) {
  const packagePath = join(...packageName.split('/'));
  const candidates = parentPackage
    ? [
        join(dirname(parentPackage), packagePath),
        join(engineRoot, 'node_modules', packagePath),
        join(engineRoot, '..', '..', 'node_modules', '.pnpm', 'node_modules', packagePath),
      ]
    : [join(engineRoot, 'node_modules', packagePath)];
  for (const candidate of candidates) {
    try {
      return await realpath(candidate);
    } catch {
      // pnpm stores transitive dependencies in its virtual store when they
      // are not hoisted beside their importer.
    }
  }
  throw new Error(`Installed runtime dependency not found: ${packageName}`);
}

async function copyPackageTree(packageName, destination, parentPackage = null, copied = new Set()) {
  const source = await installedPackagePath(packageName, parentPackage);
  const copyKey = `${source}->${destination}`;
  if (copied.has(copyKey)) return;
  copied.add(copyKey);
  await cp(source, destination, { recursive: true, dereference: true });
  const metadata = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  for (const dependency of Object.keys(metadata.dependencies ?? {})) {
    const target = join(destination, 'node_modules', ...dependency.split('/'));
    await copyPackageTree(dependency, target, source, copied);
  }
}

async function fetchNpmPackage(packageName, version, destination, tempRoot) {
  const packedName = execFileSync('npm', ['pack', `${packageName}@${version}`, '--pack-destination', tempRoot, '--silent'], {
    cwd: engineRoot,
    encoding: 'utf8',
  }).trim().split(/\r?\n/).at(-1);
  if (!packedName?.endsWith('.tgz')) throw new Error(`npm pack did not return an archive for ${packageName}`);
  await mkdir(destination, { recursive: true });
  execFileSync('tar', ['-xzf', join(tempRoot, packedName), '--strip-components=1', '-C', destination]);
}

async function stageRuntimeModules() {
  const platformPackages = {
    windows: arch === 'x86_64'
      ? ['sharp-win32-x64@0.35.4', 'sharp-libvips-win32-x64@1.3.3']
      : isWindowsX86
        ? ['sharp-win32-ia32@0.35.4', 'sharp-libvips-win32-ia32@1.3.3']
        : null,
    macos: arch === 'x86_64'
      ? ['sharp-darwin-x64@0.35.4', 'sharp-libvips-darwin-x64@1.3.3']
      : arch === 'aarch64'
        ? ['sharp-darwin-arm64@0.35.4', 'sharp-libvips-darwin-arm64@1.3.3']
        : null,
    linux: ({
      x86_64: ['sharp-linux-x64@0.35.4', 'sharp-libvips-linux-x64@1.3.3'],
      aarch64: ['sharp-linux-arm64@0.35.4', 'sharp-libvips-linux-arm64@1.3.3'],
      armv7: ['sharp-linux-arm@0.35.4', 'sharp-libvips-linux-arm@1.3.3'],
      powerpc64le: ['sharp-linux-ppc64@0.35.4', 'sharp-libvips-linux-ppc64@1.3.3'],
      s390x: ['sharp-linux-s390x@0.35.4', 'sharp-libvips-linux-s390x@1.3.3'],
    })[arch] ?? null,
  }[targetPlatform];

  if (!platformPackages) {
    console.log(`[engine-runtime] no packaged sharp runtime is configured for ${platform ?? 'unknown platform'} ${arch ?? ''}`);
    return;
  }

  const runtimeModules = join(engineDist, 'node_modules');
  const tempRoot = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'potools-runtime-')));
  await rm(runtimeModules, { recursive: true, force: true });
  await mkdir(runtimeModules, { recursive: true });
  try {
    const copied = new Set();
    for (const packageName of ['sharp', 'mupdf', 'yaml']) {
      await copyPackageTree(packageName, join(runtimeModules, ...packageName.split('/')), null, copied);
    }
    const nodeOrtArchitectures = targetPlatform === 'linux'
      ? ['x86_64', 'aarch64'].includes(arch)
      : true;
    const ortPackage = isWindowsX86 || !nodeOrtArchitectures ? 'onnxruntime-web' : 'onnxruntime-node';
    await copyPackageTree(ortPackage, join(runtimeModules, ortPackage), null, copied);
    if (ortPackage === 'onnxruntime-node') {
      const nativeRoot = join(runtimeModules, ortPackage, 'bin', 'napi-v6');
      const nativePlatform = { windows: 'win32', macos: 'darwin', linux: 'linux' }[targetPlatform];
      const nativeArch = targetPlatform === 'windows' ? 'x64' : (arch === 'aarch64' ? 'arm64' : 'x64');
      for (const platformName of ['darwin', 'linux', 'win32']) {
        if (platformName !== nativePlatform) await rm(join(nativeRoot, platformName), { recursive: true, force: true });
      }
      for (const archName of await import('node:fs/promises').then(({ readdir }) => readdir(join(nativeRoot, nativePlatform)))) {
        if (archName !== nativeArch) await rm(join(nativeRoot, nativePlatform, archName), { recursive: true, force: true });
      }
    }

    for (const spec of platformPackages) {
      const [shortName, version] = spec.split('@');
      const packageName = `@img/${shortName}`;
      const destination = join(runtimeModules, '@img', shortName);
      try {
        const sharpSource = await realpath(join(engineRoot, 'node_modules', 'sharp'));
        await copyPackageTree(packageName, destination, sharpSource, copied);
      } catch {
        await fetchNpmPackage(packageName, version, destination, tempRoot);
      }
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
  console.log(`[engine-runtime] staged sharp, mupdf, and yaml runtime for ${platform} ${arch}`);
}

if (targetPlatform === 'windows') {
  await rm(join(engineDist, 'node'), { force: true });
  await prepareWindowsNode();
} else if (targetPlatform === 'macos') {
  await rm(join(engineDist, 'node.exe'), { force: true });
  await prepareMacNode();
} else if (targetPlatform === 'linux') {
  await rm(join(engineDist, 'node.exe'), { force: true });
  await prepareLinuxNode();
}
else console.log(`[engine-runtime] no bundled Node download required for ${platform ?? 'unknown platform'}`);

if (targetPlatform === 'windows' || targetPlatform === 'macos' || targetPlatform === 'linux') {
  await stageRuntimeModules();
  await cp(
    fileURLToPath(new URL(`../public/licenses/${targetPlatform === 'windows' ? WINDOWS_NODE.license : 'Node.js-22.20.0.txt'}`, import.meta.url)),
    join(engineDist, 'node-runtime-LICENSE.txt'),
  );
} else {
  console.log(`[engine-runtime] skipping native runtime module staging for ${platform ?? 'unknown platform'}`);
}
