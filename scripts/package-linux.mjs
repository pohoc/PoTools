import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'linux') {
  throw new Error('Linux packaging must run on Linux so native WebKitGTK and target architecture are matched.');
}

const architecture = {
  x64: 'x64',
  arm64: 'arm64',
  arm: 'armv7',
  ppc64: 'ppc64le',
  s390x: 's390x',
}[process.arch];
if (!architecture) {
  throw new Error(`Linux packaging does not support the current host architecture ${process.arch}. Supported architectures: x64, arm64, armv7, ppc64le, s390x.`);
}

execFileSync('pnpm', ['icons'], { cwd: root, stdio: 'inherit' });
execFileSync('pnpm', [`package:linux:${architecture}:build`], { cwd: root, stdio: 'inherit' });
execFileSync('node', ['scripts/collect-release-artifacts.mjs', 'linux', architecture], { cwd: root, stdio: 'inherit' });
