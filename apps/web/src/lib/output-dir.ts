import { commonParentDir } from './paths.ts';

export interface OutputDirInput {
  outputMode: 'folder' | 'source';
  isDesktop: boolean;
  outputDir: string | null;
  defaultDir: string | null;
  /** Absolute paths of the job's input files; browser entries carry none. */
  filePaths: Array<string | null | undefined>;
}

/**
 * Where a file-tool job should write, from the output-mode setting.
 *
 * "Source" follows the job's own paths and is desktop only — the browser has no
 * filesystem and keeps its download flow. Anything the source mode cannot
 * resolve (no paths, no common folder) falls back to the configured folder,
 * then the engine-reported default, then null (engine picks its own).
 */
export function resolveOutputDir(input: OutputDirInput): string | null {
  const sourceDir =
    input.outputMode === 'source' && input.isDesktop
      ? commonParentDir(input.filePaths.filter((path): path is string => Boolean(path)))
      : null;
  return sourceDir ?? input.outputDir ?? input.defaultDir ?? null;
}
