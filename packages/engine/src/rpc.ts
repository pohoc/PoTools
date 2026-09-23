import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { platform } from 'node:os';
import type { EngineInfo, FileRef, JobGlobals, JobSnapshot, PageThumb, ProbedPdf, RpcMethodName, ToolId } from '@potools/core';
import { PROTOCOL_VERSION, TOOL_LIST } from '@potools/core';
import { JobManager } from './jobs.ts';
import { TOOL_IMPL_MAP } from './tools/index.ts';
import { browseDirs, defaultTempRoot, loadPdf, readInput, setTempRootDir, tempRootDir } from './lib/files.ts';
import { runTextTool } from './lib/text-run.ts';
import { cleanTemp, tempUsage } from './lib/temp.ts';
import { defaultOutputDir } from './lib/platform.ts';
import { hasUniformSize, pagesInfo, readMetadata } from './lib/pdf.ts';
import { dedupe } from './lib/naming.ts';
import { openRaster, rasterSelfCheck } from './lib/render.ts';
import { getSharp, imageSelfCheck, imageInfo, transcodePng } from './lib/images.ts';
import { selfCheckFont } from './lib/fonts.ts';
import { archiveInvoiceFiles, scanInvoiceDirectory, undoInvoiceArchive } from './lib/invoice-organizer.ts';
import { EngineError } from './errors.ts';
import { logger } from './logger.ts';
import packageJson from '../package.json';

export interface Engine {
  manager: JobManager;
  info(): EngineInfo;
  call(method: RpcMethodName, params: Record<string, unknown>): Promise<unknown>;
}

export async function createEngine(options: { concurrency?: number } = {}): Promise<Engine> {
  const manager = new JobManager(TOOL_IMPL_MAP);
  manager.concurrency = Math.max(1, options.concurrency ?? 2);

  const [rasterizer, imageCodec, cjkFont] = await Promise.all([
    rasterSelfCheck(),
    imageSelfCheck(),
    selfCheckFont(),
  ]);

  const base: Omit<EngineInfo, 'tempDir' | 'defaultTempDir'> = {
    name: '@potools/engine',
    version: packageJson.version,
    protocol: PROTOCOL_VERSION,
    platform: platform(),
    nodeVersion: process.version,
    pid: process.pid,
    defaultOutputDir: defaultOutputDir(),
    features: {
      rasterizer: rasterizer ? 'mupdf' : 'none',
      imageCodec,
      cjkFont,
      busy: false,
    },
  };

  // tempDir is read live: `engine.setTempDir` changes it after boot.
  const info = (): EngineInfo => ({
    ...base,
    tempDir: tempRootDir(),
    defaultTempDir: defaultTempRoot(),
    features: {
      ...base.features,
      busy: manager.list().some((job) => job.progress.state === 'running'),
    },
  });

  const call = (method: RpcMethodName, params: Record<string, unknown>) =>
    dispatch(manager, info, method, params ?? {});

  return { manager, info, call };
}

async function dispatch(
  manager: JobManager,
  info: () => EngineInfo,
  method: RpcMethodName,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (method) {
    case 'engine.ping':
      return { pong: Date.now() };
    case 'engine.setTempDir':
      return { tempDir: setTempRootDir(typeof params.dir === 'string' ? params.dir : null) };
    case 'engine.info':
      return info();
    case 'tools.list':
      return TOOL_LIST;
    case 'tool.run':
      return runTextTool({
        tool: params.tool as ToolId,
        options: (params.options ?? {}) as Record<string, unknown>,
        globals: params.globals as JobGlobals | undefined,
      });
    case 'job.submit':
      return manager.submit(params.job as never);
    case 'job.cancel':
      return { cancelled: manager.cancel(String(params.jobId ?? '')) };
    case 'job.list':
      return annotateArtifacts(manager);
    case 'job.clear':
      return { removed: manager.clear(params.jobIds as string[] | undefined) };
    case 'fs.browse':
      return browseDirs(typeof params.path === 'string' ? params.path : null);
    case 'file.probe':
      return probeFile(params.file as FileRef);
    case 'file.bytes': {
      const input = await readInput(params.file as FileRef);
      return { dataBase64: Buffer.from(input.bytes).toString('base64'), name: input.name };
    }
    case 'page.list': {
      const input = await readInput(params.file as FileRef);
      const doc = await loadPdf(input);
      return { pageCount: doc.getPageCount(), pages: pagesInfo(doc) };
    }
    case 'page.thumbs':
      return thumbs(params.file as FileRef, params);
    case 'file.write':
      return saveArtifact(manager, params);
    case 'shell.reveal':
      return reveal(String(params.path ?? ''), params.open === true);
    case 'shell.print':
      return printFile(String(params.path ?? ''));
    case 'temp.stat':
      return tempUsage(tempRootDir());    case 'temp.clean':
      return cleanTemp(tempRootDir(), {
        olderThanDays: Number(params.olderThanDays ?? 0),
        keepJobs: Number(params.keepJobs ?? 0),
        protect: new Set(
          manager.list().filter((job) => job.progress.state === 'running').map((job) => job.id),
        ),
      });
    case 'invoice.scan':
      return scanInvoiceDirectory({
        directory: String(params.directory ?? ''),
        recursive: params.recursive !== false,
        maxFiles: Number(params.maxFiles ?? 2000),
        excludeDirectory: params.excludeDirectory ? String(params.excludeDirectory) : undefined,
      });
    case 'invoice.archive':
      return archiveInvoiceFiles({
        sourceDirectory: String(params.sourceDirectory ?? ''),
        targetDirectory: String(params.targetDirectory ?? ''),
        conflict: params.conflict === 'skip' ? 'skip' : 'rename',
        files: Array.isArray(params.files) ? params.files as Array<{ path: string; sha256: string; relativePath: string; enabled: boolean; fields?: import('@potools/core').InvoiceScanEntry['fields'] }> : [],
      });
    case 'invoice.undo':
      return undoInvoiceArchive(String(params.archiveId ?? ''));
    default:
      throw new EngineError('bad_request', `未知方法：${method}`);
  }
}

async function probeFile(file: FileRef): Promise<ProbedPdf> {
  const input = await readInput(file);
  const doc = await loadPdf(input);
  return {
    fileId: file.id,
    name: file.name,
    sizeBytes: input.bytes.byteLength,
    pageCount: doc.getPageCount(),
    pages: pagesInfo(doc),
    metadata: readMetadata(doc),
    encrypted: false,
    uniformSize: hasUniformSize(doc),
  };
}

async function thumbs(file: FileRef, params: Record<string, unknown>): Promise<PageThumb[]> {
  const pages = Array.isArray(params.pages) ? (params.pages as number[]) : [];
  if (!pages.length) return [];
  const width = Math.min(2400, Math.max(48, Number(params.width) || 160));
  const format = params.format === 'png' || width > 600 ? 'png' : 'jpeg';
  const quality = Math.min(95, Math.max(45, Number(params.quality) || (width > 600 ? 92 : 68)));
  const input = await readInput(file);
  const out: PageThumb[] = [];
  let raster: Awaited<ReturnType<typeof openRaster>> | null = null;
  try {
    try {
      raster = await openRaster(input.bytes);
    } catch {
      // Raster inputs use the same preview RPC as PDFs, including native paths.
      const sharp = await getSharp();
      if (!sharp) throw new EngineError('no_image_codec', '图片编解码器不可用', 'error.noImageCodec');
      const meta = await imageInfo(input.bytes);
      const page = pages.includes(1) ? 1 : 0;
      if (page) {
        const image = sharp(input.bytes, { failOn: 'none' }).rotate().resize({ width, withoutEnlargement: true });
        const imageMeta = await image.metadata();
        const imageFormat = format === 'png' ? 'png' : 'jpeg';
        const bytes = imageFormat === 'png'
          ? await image.flatten({ background: '#ffffff' }).png({ compressionLevel: 6 }).toBuffer()
          : await image.flatten({ background: '#ffffff' }).jpeg({ quality }).toBuffer();
        out.push({
          page,
          dataUrl: `data:image/${imageFormat};base64,${Buffer.from(bytes).toString('base64')}`,
          width: imageMeta.width ?? meta.width,
          height: imageMeta.height ?? meta.height,
          rotation: 0,
        });
      }
      return out;
    }
    for (const page of pages) {
      if (page < 1 || page > raster.pageCount) continue;
      const box = raster.pageBox(page);
      const dpi = Math.min(600, (width / Math.max(1, box.width)) * 72);
      const png = raster.renderPng({ page, dpi });
      const bytes = format === 'png' ? png : await transcodePng(png, { format, quality });
      out.push({
        page,
        dataUrl: `data:image/${format === 'png' ? 'png' : 'jpeg'};base64,${Buffer.from(bytes).toString('base64')}`,
        width: Math.round(box.width),
        height: Math.round(box.height),
        rotation: 0,
      });
    }
  } finally {
    raster?.close();
  }
  return out;
}

async function saveArtifact(manager: JobManager, params: Record<string, unknown>) {
  if (typeof params.dataBase64 === 'string') {
    const dir = params.dir ? String(params.dir) : '';
    if (!dir) throw new EngineError('bad_request', '直接写入内容时必须提供目录');
    await stat(dir).catch(() => {
      throw new EngineError('write_failed', `目录不存在：${dir}`);
    });
    const bytes = Buffer.from(params.dataBase64, 'base64');
    const name = dedupeName(String(params.name ?? '') || 'output.txt');
    const target = await freePath(dir, name);
    await writeFile(target, bytes);
    logger.info('text saved', { dir, name, sizeBytes: bytes.byteLength });
    return { path: target, name: basename(target) };
  }
  const jobId = String(params.jobId ?? '');
  const artifactId = String(params.artifactId ?? '');
  const staged =
    (jobId && artifactId ? manager.artifactPath(jobId, artifactId) : undefined) ??
    (params.from ? withinTemp(String(params.from)) : undefined);
  if (!staged) throw new EngineError('bad_request', '找不到该产物');
  // The queue keeps finished jobs visible, but a cleanup can empty their files.
  if (!(await stat(staged).then((info) => info.isFile(), () => false))) {
    throw new EngineError('bad_request', '该产物的临时文件已被清理，请重新运行');
  }
  const dir = params.dir ? String(params.dir) : null;
  if (!dir) return { path: staged, name: basename(staged) };
  await stat(dir).catch(() => {
    throw new EngineError('write_failed', `目录不存在：${dir}`);
  });
  const name = dedupeName(String(params.name ?? '') || basename(staged));
  const target = await freePath(dir, name);
  await copyFile(staged, target);
  logger.info('artifact saved', { jobId, artifactId, target });
  return { path: target, name: basename(target) };
}

/** Never clobbers an existing file in the destination folder. */
async function freePath(dir: string, name: string): Promise<string> {
  const taken = new Set<string>();
  let candidate = name;
  for (;;) {
    const exists = await stat(join(dir, candidate)).then(() => true, () => false);
    if (!exists) return join(dir, candidate);
    taken.add(candidate);
    candidate = dedupe(name, taken);
  }
}

/**
 * Re-reads the disk so a cleaned-up job cannot be offered as still saveable:
 * `path` drops when the reported file is gone, `stagedMissing` when only the
 * engine's own staged copy is.
 */
async function annotateArtifacts(manager: JobManager): Promise<JobSnapshot[]> {
  const exists = (path: string | null | undefined) =>
    path ? stat(path).then((info) => info.isFile(), () => false) : Promise.resolve(false);
  return Promise.all(manager.list().map(async (job) => ({
    ...job,
    artifacts: await Promise.all(job.artifacts.map(async (artifact) => {
      const staged = manager.artifactPath(job.id, artifact.id);
      const stagedMissing = staged ? !(await exists(staged)) : false;
      if (!stagedMissing && (await exists(artifact.path))) return artifact;
      return {
        ...artifact,
        stagedMissing,
        path: stagedMissing || artifact.path === staged ? null : artifact.path,
      };
    })),
  })));
}

/** Only ever copies files the engine itself staged. */
function withinTemp(path: string): string | null {
  const resolved = resolve(path);
  return resolved.startsWith(`${tempRootDir()}${sep}`) ? resolved : null;
}

function dedupeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 160) || 'output.pdf';
}

async function reveal(path: string, open: boolean) {
  if (!path) throw new EngineError('bad_request', '缺少路径');
  await stat(path).catch(() => {
    throw new EngineError('bad_request', `路径不存在：${path}`);
  });
  const os = platform();
  const command = os === 'darwin' ? 'open' : os === 'win32' ? 'explorer' : 'xdg-open';
  const args =
    os === 'darwin'
      ? open
        ? [path]
        : ['-R', path]
      : os === 'win32'
        ? open
          ? [path]
          : ['/select,', path]
        : [path];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.on('error', (error) => logger.warn('reveal failed', { error: String(error) }));
  child.unref();
  return { revealed: true, path };
}

const execFileAsync = promisify(execFile);

async function printFile(path: string) {
  if (!path) throw new EngineError('bad_request', '缺少待打印文件路径');
  await stat(path).catch(() => { throw new EngineError('bad_request', `待打印文件不存在：${path}`); });
  const os = platform();
  try {
    if (os === 'win32') {
      await execFileAsync('powershell.exe', ['-NoProfile', '-Command', 'Start-Process -LiteralPath $args[0] -Verb Print', path], { timeout: 15000 });
    } else {
      const { stdout } = await execFileAsync('lp', [path], { timeout: 30000 });
      return { started: true, queue: stdout.trim() };
    }
    return { started: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new EngineError('bad_request', `无法发起系统打印，请确认已配置默认打印机和文件关联：${detail}`);
  }
}
