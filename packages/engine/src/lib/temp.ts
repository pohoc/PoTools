import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { TempCleanResult, TempUsage } from '@potools/core';
import { logger } from '../logger.ts';

interface Entry {
  name: string;
  path: string;
  mtimeMs: number;
}

async function topLevel(root: string, sub: string): Promise<Entry[]> {
  const dir = join(root, sub);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: Entry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    const info = await stat(path).catch(() => null);
    out.push({ name: entry.name, path, mtimeMs: info?.mtimeMs ?? 0 });
  }
  return out;
}

async function dirSize(path: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const stack = [path];
  while (stack.length) {
    const current = stack.pop() as string;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const next = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(next);
        continue;
      }
      const info = await stat(next).catch(() => null);
      files += 1;
      bytes += info?.size ?? 0;
    }
  }
  return { files, bytes };
}

export async function tempUsage(root: string): Promise<TempUsage> {
  const groups = [...(await topLevel(root, 'jobs')), ...(await topLevel(root, 'inbox'))];
  let files = 0;
  let bytes = 0;
  for (const group of groups) {
    const size = await dirSize(group.path);
    files += size.files;
    bytes += size.bytes;
  }
  const times = groups.map((group) => group.mtimeMs).filter((value) => value > 0);
  return {
    dir: root,
    jobs: groups.length,
    files,
    bytes,
    oldestAt: times.length ? Math.min(...times) : null,
    newestAt: times.length ? Math.max(...times) : null,
  };
}

/**
 * Deletes staged job folders older than `olderThanDays`. `keepJobs` always
 * spares the most recent N runs, and `protect` spares ids still in flight.
 */
export async function cleanTemp(
  root: string,
  options: { olderThanDays?: number; keepJobs?: number; protect?: Set<string> } = {},
): Promise<TempCleanResult> {
  const days = options.olderThanDays ?? 0;
  const keep = Math.max(0, options.keepJobs ?? 0);
  const cutoff = days > 0 ? Date.now() - days * 86_400_000 : Infinity;
  let removedJobs = 0;
  let removedFiles = 0;
  let freedBytes = 0;
  let keptJobs = 0;

  for (const sub of ['jobs', 'inbox']) {
    const groups = (await topLevel(root, sub)).sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const [index, group] of groups.entries()) {
      const protectedJob = options.protect?.has(group.name);
      if (index < keep || protectedJob || group.mtimeMs > cutoff) {
        keptJobs += 1;
        continue;
      }
      const size = await dirSize(group.path);
      await rm(group.path, { recursive: true, force: true }).catch((error) =>
        logger.warn('temp clean failed', { path: group.path, error: String(error) }),
      );
      removedJobs += 1;
      removedFiles += size.files;
      freedBytes += size.bytes;
    }
  }
  return { removedJobs, removedFiles, freedBytes, keptJobs };
}
