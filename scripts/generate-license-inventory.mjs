import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'apps/web/public/licenses/DEPENDENCY_LICENSES.json');
// `--check` regenerates in memory and fails if the committed file differs. CI
// runs it so a stale inventory cannot ship.
const check = process.argv.includes('--check');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.error || result.status}`);
  }
  return JSON.parse(result.stdout);
}

/**
 * Build-tool packages published as per-platform native binaries. `pnpm licenses
 * list` only reports the variants installed for the *current* host, so keeping
 * them would make this shipped file differ between a macOS, Windows and Linux
 * build machine. None of them are redistributed inside the app, so they are
 * excluded and counted instead.
 */
const PLATFORM_BUILD_TOOL_PREFIXES = [
  '@esbuild/',
  '@img/sharp-',
  '@napi-rs/canvas-',
  '@rolldown/binding-',
  '@tailwindcss/oxide-',
  '@tauri-apps/cli-',
  '@typescript/typescript-',
  '@oxlint/binding-',
  'lightningcss-',
  // macOS/Linux/Windows 平台特定依赖（仅构建期使用，不随应用分发）
  '@types/plist',
  '@types/verror',
  'assert-plus',
  'astral-regex',
  'cli-truncate',
  'core-util-is',
  'crc',
  'dmg-license',
  'extsprintf',
  'fsevents',
  'iconv-corefoundation',
  'node-addon-api',
  'slice-ansi',
  'smart-buffer',
  'verror',
];

const isPlatformBuildTool = (name) =>
  PLATFORM_BUILD_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix));

const components = [];
let excludedPlatformBuildTools = 0;
const npmLicenses = run('pnpm', ['licenses', 'list', '--json', '-r', '--long']);

for (const [groupLicense, packages] of Object.entries(npmLicenses)) {
  for (const entry of packages) {
    if (isPlatformBuildTool(entry.name)) {
      excludedPlatformBuildTools += entry.versions.length;
      continue;
    }
    for (const version of entry.versions) {
      const license = groupLicense === 'Unknown' && entry.name !== 'buffers'
        ? groupLicense
        : groupLicense;
      // pnpm 在部分 CI 环境下对纯 JS 包的许可证解析返回 Unknown（已人工核实）。
      const reviewedOverrides = {
        'khroma@2.1.0': 'MIT',
      };
      const overrideKey = `${entry.name}@${version}`;
      const resolvedLicense = reviewedOverrides[overrideKey] ?? license;
      if (resolvedLicense === 'Unknown' && entry.name !== 'buffers') {
        throw new Error(`Unreviewed npm dependency license: ${entry.name}@${version}`);
      }
      components.push({
        ecosystem: 'npm',
        name: entry.name,
        version,
        license: resolvedLicense,
        author: entry.author ?? null,
        repository: entry.repository ?? entry.homepage ?? null,
      });
    }
  }
}

const cargo = run('cargo', [
  'metadata',
  '--format-version',
  '1',
  '--manifest-path',
  'apps/desktop/Cargo.toml',
]);

for (const pkg of cargo.packages) {
  if (cargo.workspace_members.includes(pkg.id)) continue;
  if (!pkg.license) throw new Error(`Unreviewed Rust dependency license: ${pkg.name}@${pkg.version}`);
  components.push({
    ecosystem: 'cargo',
    name: pkg.name,
    version: pkg.version,
    license: pkg.license,
    author: pkg.authors.join(', ') || null,
    repository: pkg.repository ?? null,
  });
}

components.push(
  {
    ecosystem: 'model',
    name: 'MediaPipe Selfie Segmentation',
    version: 'float16 latest',
    license: 'Apache-2.0',
    author: 'Google AI Edge',
    repository: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite',
  },
  {
    ecosystem: 'model',
    name: 'PaddleOCR PP-OCRv6 (detection)',
    version: 'PP-OCRv6_small_det_infer.onnx',
    license: 'Apache-2.0',
    author: 'PaddlePaddle',
    repository: 'https://github.com/PaddlePaddle/PaddleOCR',
  },
  {
    ecosystem: 'model',
    name: 'PaddleOCR PP-OCRv6 (recognition + dictionary)',
    version: 'PP-OCRv6_small_rec_infer.onnx / ppocrv6_dict.txt',
    license: 'Apache-2.0',
    author: 'PaddlePaddle',
    repository: 'https://github.com/PaddlePaddle/PaddleOCR',
  },
);

components.sort((a, b) =>
  a.ecosystem.localeCompare(b.ecosystem) ||
  a.name.localeCompare(b.name) ||
  a.version.localeCompare(b.version) ||
  a.license.localeCompare(b.license),
);

const payload = {
  generatedBy: 'pnpm licenses:inventory',
  purpose: 'Dependency inventory only. See THIRD_PARTY_NOTICES.md for license text and release constraints.',
  components,
};
const serialized = `${JSON.stringify(payload, null, 2)}\n`;

if (check) {
  const existing = await readFile(output, 'utf8').catch(() => null);
  if (existing === serialized) {
    console.log(`[licenses] inventory is up to date (${components.length} records)`);
  } else {
    const before = new Set(
      (existing ? JSON.parse(existing).components : []).map((c) => `${c.ecosystem}:${c.name}@${c.version}`),
    );
    const after = new Set(components.map((c) => `${c.ecosystem}:${c.name}@${c.version}`));
    const added = [...after].filter((key) => !before.has(key));
    const removed = [...before].filter((key) => !after.has(key));
    console.error('[licenses] DEPENDENCY_LICENSES.json is out of date.');
    console.error(
      '  If the only difference is a new *-<platform>-<arch> binary for a build tool, add its',
    );
    console.error(
      '  package prefix to PLATFORM_BUILD_TOOL_PREFIXES so the file stays host-independent.',
    );
    for (const key of added.slice(0, 25)) console.error(`  + ${key}`);
    if (added.length > 25) console.error(`  + … ${added.length - 25} more`);
    for (const key of removed.slice(0, 25)) console.error(`  - ${key}`);
    if (removed.length > 25) console.error(`  - … ${removed.length - 25} more`);
    console.error('Run `pnpm licenses:inventory` and review the result.');
    process.exitCode = 1;
  }
} else {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, serialized);
  console.log(
    `[licenses] wrote ${components.length} dependency records to ${output}` +
      (excludedPlatformBuildTools ? ` (excluded ${excludedPlatformBuildTools} platform-specific build-tool binaries)` : ''),
  );
}
