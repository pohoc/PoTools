import { endianness, machine } from 'node:os';

const targetArch = process.argv[2];
const expectedArch = {
  x64: 'x64',
  arm64: 'arm64',
  armv7: 'arm',
  ppc64le: 'ppc64',
  s390x: 's390x',
}[targetArch];

if (!expectedArch) throw new Error('Usage: node scripts/assert-linux-build-host.mjs <x64|arm64|armv7|ppc64le|s390x>');

const hostMachine = machine();
const matchesTarget = {
  x64: process.arch === 'x64' && hostMachine === 'x86_64',
  arm64: process.arch === 'arm64' && hostMachine === 'aarch64',
  armv7: process.arch === 'arm'
    && /^armv7(?:l)?$/.test(hostMachine)
    && Number(process.config.variables.arm_version) >= 7
    && process.config.variables.arm_float_abi === 'hard',
  ppc64le: process.arch === 'ppc64' && hostMachine === 'ppc64le' && endianness() === 'LE',
  s390x: process.arch === 's390x' && hostMachine === 's390x',
}[targetArch];

if (process.platform !== 'linux' || !matchesTarget) {
  throw new Error(
    `Linux ${targetArch} packages must be built on a matching native Linux host; current host is ${process.platform}/${process.arch}/${hostMachine}${targetArch === 'armv7' ? ` (ARMv${process.config.variables.arm_version ?? 'unknown'}, ${process.config.variables.arm_float_abi ?? 'unknown'}-float)` : ''}.`,
  );
}
