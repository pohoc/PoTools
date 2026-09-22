import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'apps/desktop/public/licenses/DEPENDENCY_LICENSES.json');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.error || result.status}`);
  }
  return JSON.parse(result.stdout);
}

const components = [];
const npmLicenses = run('pnpm', ['licenses', 'list', '--json', '-r', '--long']);

for (const [groupLicense, packages] of Object.entries(npmLicenses)) {
  for (const entry of packages) {
    for (const version of entry.versions) {
      const license = groupLicense === 'Unknown' && entry.name === 'buffers' && version === '0.1.1'
        ? 'MIT (verified from upstream history; see MIT-buffers-0.1.1.txt)'
        : groupLicense;
      if (groupLicense === 'Unknown' && entry.name !== 'buffers') {
        throw new Error(`Unreviewed npm dependency license: ${entry.name}@${version}`);
      }
      components.push({
        ecosystem: 'npm',
        name: entry.name,
        version,
        license,
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
  'apps/desktop/src-tauri/Cargo.toml',
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
    ecosystem: 'external-runtime',
    name: 'Node.js',
    version: '22.20.0',
    license: 'MIT and bundled third-party notices',
    author: 'OpenJS Foundation and Node.js contributors',
    repository: 'https://github.com/nodejs/node/tree/v22.20.0',
  },
  {
    ecosystem: 'external-runtime',
    name: 'ONLYOFFICE Document Builder',
    version: '9.4.0 (optional)',
    license: 'AGPL-3.0 with upstream additional terms or commercial license',
    author: 'Ascensio System SIA',
    repository: 'https://github.com/ONLYOFFICE/DocumentBuilder',
  },
  {
    ecosystem: 'model',
    name: 'MediaPipe Selfie Segmentation',
    version: 'float16 latest',
    license: 'Apache-2.0',
    author: 'Google AI Edge',
    repository: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite',
  },
);

components.sort((a, b) =>
  a.ecosystem.localeCompare(b.ecosystem) ||
  a.name.localeCompare(b.name) ||
  a.version.localeCompare(b.version) ||
  a.license.localeCompare(b.license),
);

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify({
  generatedBy: 'pnpm licenses:inventory',
  purpose: 'Dependency inventory only. See THIRD_PARTY_NOTICES.md for license text and release constraints.',
  components,
}, null, 2)}\n`);

console.log(`[licenses] wrote ${components.length} dependency records to ${output}`);
