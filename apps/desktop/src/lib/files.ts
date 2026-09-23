import type { FileRef, OutputFile } from 'core';
import { isTauri, nativeOpenPath, nativePickDirectory, nativePickFiles, nativeSaveAs, ACCEPT_EXTENSIONS, type AcceptKind } from './tauri.ts';
import { getTransport } from './transport.ts';

export interface PickedFile {
  id: string;
  name: string;
  size: number;
  /** Absolute path in desktop mode. */
  path: string | null;
  /** The browser File object in web mode. */
  file: File | null;
}

let fileCounter = 0;
const newId = (): string => `f${Date.now().toString(36)}${(fileCounter += 1)}`;

export function acceptsFor(kind: AcceptKind): string {
  return ACCEPT_EXTENSIONS[kind].mime;
}

/** Maps a descriptor's `accept` string onto a picker filter. */
export function kindFor(accept: string): AcceptKind {
  if (accept === '*/*') return 'any';
  if (accept === 'image/jpeg,image/png,image/webp') return 'portrait';
  if (accept === 'image/*') return 'image';
  if (accept.includes('application/pdf') && accept.includes('image/*')) return 'pdf-image';
  if (accept.startsWith('image/')) return 'raster';
  if (accept.includes('ofd')) return 'ofd';
  if (accept.includes('markdown') || accept.includes('text/plain')) return 'markdown';
  return 'pdf';
}

export function fromPaths(paths: string[]): PickedFile[] {
  return paths.map((path) => ({
    id: newId(),
    name: path.split(/[/\\]/).pop() ?? path,
    size: 0,
    path,
    file: null,
  }));
}

export async function pickFiles(accept: AcceptKind, multiple: boolean): Promise<PickedFile[]> {
  if (isTauri()) {
    return fromPaths(await nativePickFiles(accept, multiple));
  }
  return new Promise<PickedFile[]>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = acceptsFor(accept);
    input.multiple = multiple;
    input.onchange = () => {
      const files = Array.from(input.files ?? []);
      resolve(
        files.map((file) => ({
          id: newId(),
          name: file.name,
          size: file.size,
          path: null,
          file,
        })),
      );
    };
    input.click();
  });
}

export function filesFromDataTransfer(transfer: DataTransfer): PickedFile[] {
  const out: PickedFile[] = [];
  const seen = new Set<string>();
  const candidates = [
    ...Array.from(transfer.files ?? []),
    ...Array.from(transfer.items ?? []).flatMap((item) => item.kind === 'file' ? [item.getAsFile()].filter((file): file is File => file !== null) : []),
  ];
  for (const file of candidates) {
    const signature = `${file.name}|${file.size}|${file.type}|${file.lastModified}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    out.push({
      id: newId(),
      name: file.name,
      size: file.size,
      path: null,
      file,
    });
  }
  return out;
}

/** Native mode sends paths only; web mode inlines the bytes as base64. */
export async function toFileRef(picked: PickedFile): Promise<FileRef> {
  if (picked.path) {
    return { id: picked.id, name: picked.name, path: picked.path, sizeBytes: picked.size };
  }
  if (!picked.file) throw new Error('file has neither path nor bytes');
  const buffer = await picked.file.arrayBuffer();
  return {
    id: picked.id,
    name: picked.name,
    sizeBytes: picked.size,
    dataBase64: toBase64(new Uint8Array(buffer)),
  };
}

/** Avoid retaining both a browser File and its base64 copy after RPC completes. */
export function releasePickedFileBytes(picked: PickedFile): void {
  picked.file = null;
}

function toBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function artifactBytes(artifact: OutputFile): Uint8Array | null {
  if (!artifact.dataBase64) return null;
  const binary = atob(artifact.dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function downloadArtifact(artifact: OutputFile): Promise<void> {
  const bytes = artifactBytes(artifact);
  if (!bytes) {
    await revealArtifact(artifact);
    return;
  }
  const url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer]));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = artifact.name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export async function revealArtifact(artifact: OutputFile): Promise<void> {
  if (!artifact.path) return;
  if (isTauri()) {
    await getTransport().call('shell.reveal', { path: artifact.path });
    return;
  }
  await getTransport().call('shell.reveal', { path: artifact.path });
}

/** Opens the file with the OS default handler (desktop mode only). */
export async function openArtifact(artifact: OutputFile): Promise<void> {
  if (!artifact.path) return;
  await nativeOpenPath(artifact.path);
}

/** Native folder picker; returns null in the browser, where downloads are used. */
export async function chooseSaveDir(): Promise<string | null> {
  return isTauri() ? nativePickDirectory() : null;
}

/** Copies one staged artifact into a folder the user picked. */
export async function saveArtifactToFolder(
  jobId: string,
  artifact: OutputFile,
  dir: string,
): Promise<string | null> {
  const result = await getTransport().call<{ path: string }>('file.write', {
    jobId,
    artifactId: artifact.id,
    from: artifact.path ?? undefined,
    dir,
    name: artifact.name,
  });
  return result.path ?? null;
}

/**
 * "Save all" entry point: native mode asks for a folder once, browser mode
 * falls back to downloads because the page cannot pick a directory.
 */
export async function saveAllToFolder(jobId: string, artifacts: OutputFile[]): Promise<number> {
  const dir = isTauri() ? await nativePickDirectory() : null;
  if (!dir) {
    const inline = artifacts.filter((artifact) => artifact.dataBase64);
    for (const artifact of inline) await downloadArtifact(artifact);
    return inline.length;
  }
  let saved = 0;
  for (const artifact of artifacts) {
    if (!artifact.path) continue;
    await saveArtifactToFolder(jobId, artifact, dir);
    saved += 1;
  }
  return saved;
}

export async function saveArtifactAs(artifact: OutputFile): Promise<string | null> {
  if (isTauri()) {
    return nativeSaveAs(artifact.name, artifactBytes(artifact) ?? undefined);
  }
  await downloadArtifact(artifact);
  return null;
}
