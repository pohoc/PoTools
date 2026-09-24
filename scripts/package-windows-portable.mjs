import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const architecture = process.argv[2];
const targets = {
  x64: 'x86_64-pc-windows-msvc',
  x86: 'i686-pc-windows-msvc',
};

if (!targets[architecture]) {
  throw new Error('Usage: node scripts/package-windows-portable.mjs <x64|x86>');
}

const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const target = targets[architecture];
const targetDir = path.join(root, 'apps/desktop/src-tauri/target', target);
const executable = path.join(targetDir, 'release/potools.exe');
const portableDir = path.join(targetDir, 'release/bundle/portable/PoTools');
const archive = path.join(
  targetDir,
  'release/bundle',
  `PoTools_${version}_windows_${architecture}-portable.zip`,
);

const exeBytes = await readFile(executable);
if (!exeBytes.includes(Buffer.from('POTOOLS_NODE_EMBED_RUNTIME_V1'))) {
  throw new Error(`Refusing to make a single-EXE portable package from a build without the embedded Node runtime marker: ${executable}`);
}

await mkdir(path.dirname(portableDir), { recursive: true });
await rm(portableDir, { recursive: true, force: true });
await rm(archive, { force: true });
await mkdir(portableDir, { recursive: true });
const exeName = Buffer.from('PoTools.exe');
const crc32 = createCrc32(exeBytes);
const localHeader = Buffer.alloc(30 + exeName.length);
localHeader.writeUInt32LE(0x04034b50, 0);
localHeader.writeUInt16LE(20, 4);
localHeader.writeUInt16LE(0x0800, 6);
localHeader.writeUInt16LE(0, 8);
localHeader.writeUInt32LE(crc32, 14);
localHeader.writeUInt32LE(exeBytes.length, 18);
localHeader.writeUInt32LE(exeBytes.length, 22);
localHeader.writeUInt16LE(exeName.length, 26);
exeName.copy(localHeader, 30);

const centralHeader = Buffer.alloc(46 + exeName.length);
centralHeader.writeUInt32LE(0x02014b50, 0);
centralHeader.writeUInt16LE(20, 4);
centralHeader.writeUInt16LE(20, 6);
centralHeader.writeUInt16LE(0x0800, 8);
centralHeader.writeUInt16LE(0, 10);
centralHeader.writeUInt32LE(crc32, 16);
centralHeader.writeUInt32LE(exeBytes.length, 20);
centralHeader.writeUInt32LE(exeBytes.length, 24);
centralHeader.writeUInt16LE(exeName.length, 28);
exeName.copy(centralHeader, 46);

const endRecord = Buffer.alloc(22);
endRecord.writeUInt32LE(0x06054b50, 0);
endRecord.writeUInt16LE(1, 8);
endRecord.writeUInt16LE(1, 10);
endRecord.writeUInt32LE(centralHeader.length, 12);
endRecord.writeUInt32LE(localHeader.length + exeBytes.length, 16);

await writeFile(path.join(portableDir, 'PoTools.exe'), exeBytes);
await writeFile(archive, Buffer.concat([localHeader, exeBytes, centralHeader, endRecord]));
console.log(`[windows-portable] created ${archive}`);

function createCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
