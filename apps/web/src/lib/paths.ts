/**
 * Longest common parent directory of the given absolute paths — the target for
 * "save next to the source files". Null when the paths share nothing beyond a
 * filesystem root (different drives on Windows, bare POSIX root), which callers
 * treat as "no dynamic folder available".
 */
export function commonParentDir(paths: string[]): string | null {
  const first = paths[0];
  if (!first) return null;
  const sep = first.includes('\\') ? '\\' : '/';
  // Drop the file name so every list is a directory; the leading '' of an
  // absolute POSIX path is kept on purpose — joining it back yields the root.
  const dirs = paths.map((path) => path.split(/[\\/]/).slice(0, -1));
  const head = dirs[0];
  if (!head) return null;
  const common: string[] = [];
  for (let index = 0; index < head.length; index++) {
    const segment = head[index];
    if (segment === undefined) break;
    if (dirs.every((dir) => dir[index] === segment)) common.push(segment);
    else break;
  }
  if (!common.length) return null;
  // A bare drive ("C:") or bare root is not a useful destination.
  const only = common[0];
  if (common.length === 1 && (only === undefined || only === '' || only.endsWith(':'))) return null;
  const joined = common.join(sep);
  return joined.length ? joined : null;
}
