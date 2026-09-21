import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const APP_FOLDER = 'PoTools';

/**
 * Picks a sensible results folder per platform: the localized Documents
 * directory when it exists (Linux ships `~/文档`, `~/Documents`, …), otherwise
 * a folder in the home directory.
 */
export function defaultOutputDir(): string {
  const home = resolve(homedir());
  const onedrive = process.env.OneDrive;
  const parents: string[] =
    process.platform === 'win32'
      ? [
          ...(onedrive ? [join(onedrive, 'Documents')] : []),
          join(process.env.USERPROFILE ?? home, 'Documents'),
          home,
        ]
      : [
          join(home, 'Documents'),
          join(home, '文档'),
          join(home, 'Skrivbord'),
          join(home, 'Schreibtisch'),
          join(home, 'Bureau'),
          home,
        ];

  for (const parent of parents) {
    if (existsSync(parent)) return join(parent, APP_FOLDER);
  }
  return join(home, APP_FOLDER);
}

export function pathStyle(): 'windows' | 'posix' {
  return process.platform === 'win32' ? 'windows' : 'posix';
}
