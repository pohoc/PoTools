import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  EngineEvent,
  FileKind,
  JobError,
  JobRequest,
  JobSnapshot,
  OutputFile,
  ToolId,
} from '@potools/core';
import { TOOLS } from '@potools/core';
import { EngineError, toJobError } from './errors.ts';
import { logger } from './logger.ts';
import { coerceOptions } from './lib/options.ts';
import { ensureDir, readInput, tempJobDir } from './lib/files.ts';
import { baseName, dedupe } from './lib/naming.ts';
import type { ArtifactDraft, Progress, ResolvedInput, ToolImpl } from './types.ts';

const MAX_INLINE_BYTES = 8 * 1024 * 1024;

interface Record_ {
  request: JobRequest;
  snapshot: JobSnapshot;
  artifactPaths: Map<string, string>;
}

export class JobManager {
  private records = new Map<string, Record_>();
  private order: string[] = [];
  private queue: string[] = [];
  private active = new Set<string>();
  private cancelled = new Set<string>();
  private listeners = new Set<(event: EngineEvent) => void>();

  concurrency = 2;

  constructor(private tools: Partial<Record<ToolId, ToolImpl>>) {}

  on(listener: (event: EngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): JobSnapshot[] {
    return this.order.map((id) => this.records.get(id)?.snapshot).filter(Boolean) as JobSnapshot[];
  }

  get(jobId: string): JobSnapshot | undefined {
    return this.records.get(jobId)?.snapshot;
  }

  artifactPath(jobId: string, artifactId: string): string | undefined {
    return this.records.get(jobId)?.artifactPaths.get(artifactId);
  }

  clear(jobIds?: string[]): number {
    const ids = jobIds ?? this.order.filter((id) => isTerminal(this.records.get(id)?.snapshot));
    for (const id of ids) {
      if (this.active.has(id)) continue;
      this.records.delete(id);
      this.order = this.order.filter((entry) => entry !== id);
    }
    return ids.length;
  }

  submit(request: JobRequest): JobSnapshot {
    if (!TOOLS[request.tool]) throw new EngineError('unknown_tool', `未知工具：${request.tool}`);
    if (!this.tools[request.tool]) throw new EngineError('unknown_tool', `引擎未实现：${request.tool}`);
    const files = request.files ?? [];
    if (TOOLS[request.tool]?.requiresInput !== false && !files.length) {
      throw new EngineError('bad_request', '请先添加文件');
    }
    if (this.records.has(request.id)) request.id = `${request.id}-${Date.now() % 10000}`;

    const snapshot: JobSnapshot = {
      id: request.id,
      tool: request.tool,
      label: request.label,
      fileNames: files.map((file) => file.name),
      createdAt: request.createdAt ?? Date.now(),
      progress: { state: 'queued', percent: 0 },
      artifacts: [],
      warnings: [],
    };
    this.records.set(request.id, { request, snapshot, artifactPaths: new Map() });
    this.order.unshift(request.id);
    this.queue.push(request.id);
    this.emitJob(snapshot);
    void this.pump();
    return snapshot;
  }

  cancel(jobId: string): boolean {
    const record = this.records.get(jobId);
    if (!record || isTerminal(record.snapshot)) return false;
    if (!this.active.has(jobId)) {
      this.queue = this.queue.filter((id) => id !== jobId);
      finish(record.snapshot, { state: 'cancelled', percent: 0 });
      record.snapshot.finishedAt = Date.now();
      this.emitJob(record.snapshot);
      return true;
    }
    this.cancelled.add(jobId);
    updateProgress(record.snapshot, { state: 'running', percent: record.snapshot.progress.percent, phase: 'cancelled' });
    this.emitJob(record.snapshot);
    return true;
  }

  private async pump(): Promise<void> {
    while (this.active.size < this.concurrency && this.queue.length) {
      const id = this.queue.shift();
      if (!id) break;
      const record = this.records.get(id);
      if (!record || isTerminal(record.snapshot)) continue;
      this.active.add(id);
      void this.run(record).finally(() => {
        this.active.delete(id as string);
        this.cancelled.delete(id as string);
        void this.pump();
      });
    }
  }

  private async run(record: Record_): Promise<void> {
    const { request, snapshot } = record;
    const tool = this.tools[request.tool] as ToolImpl;
    const started = Date.now();
    updateProgress(snapshot, { state: 'running', percent: 1, phase: 'prepare' });
    this.emitJob(snapshot);

    let inputs: ResolvedInput[] = [];
    try {
      inputs = await Promise.all((request.files ?? []).map((file) => readInput(file, request.id)));
      const warnings: string[] = [];
      const jobDir = tempJobDir(request.id);
      await ensureDir(jobDir);
      let lastEmit = 0;

      const ctx = {
        inputs,
        globals: request.globals ?? {},
        output: request.output,
        namePattern: request.namePattern,
        warnings,
        options: coerceOptions(TOOLS[request.tool], request.options),
        cancelled: () => this.cancelled.has(request.id),
        report: (progress: Progress) => {
          const now = Date.now();
          if (now - lastEmit < 120 && progress.percent < 100) return;
          lastEmit = now;
          updateProgress(snapshot, { state: 'running', ...progress });
          this.emitJob(snapshot);
        },
        emit: (draft: ArtifactDraft) => this.collect(record, jobDir, draft),
        emitPdf: (name: string, bytes: Uint8Array, sourceFileId?: string) =>
          this.collect(record, jobDir, { name, kind: 'pdf', bytes, sourceFileId }),
      };

      if (this.cancelled.has(request.id)) throw new EngineError('cancelled', '已取消');
      const result = await tool.run(ctx as never);
      if (this.cancelled.has(request.id)) throw new EngineError('cancelled', '已取消');

      const inputBytes = inputs.reduce((sum, input) => sum + input.bytes.byteLength, 0);
      const outputBytes = snapshot.artifacts.reduce((sum, item) => sum + item.sizeBytes, 0);
      const extra = result?.extra ?? {};
      snapshot.summary = {
        inputBytes,
        outputBytes,
        pageCountIn: result?.pageCountIn ?? 0,
        pageCountOut: result?.pageCountOut ?? snapshot.artifacts.length,
        sizeDeltaPercent: inputBytes > 0 ? Math.round(((outputBytes - inputBytes) / inputBytes) * 100) : 0,
        extra: Object.keys(extra).length ? extra : undefined,
      };
      snapshot.warnings = warnings;
      finish(snapshot, { state: 'succeeded', percent: 100, phase: 'done' });
      logger.info('job finished', { id: request.id, tool: request.tool, ms: Date.now() - started });
    } catch (error) {
      const jobError: JobError = error instanceof EngineError ? error.toJobError() : toJobError(error);
      if (jobError.code === 'cancelled') {
        finish(snapshot, { state: 'cancelled', percent: 0 });
      } else {
        snapshot.error = jobError;
        finish(snapshot, { state: 'failed', percent: snapshot.progress.percent });
        logger.error('job failed', { id: request.id, tool: request.tool, error: jobError.message });
      }
    }
    snapshot.finishedAt = Date.now();
    this.emitJob(snapshot);
  }

  /**
   * Every artifact is kept under the job temp dir so results can be re-saved or
   * revealed later; a copy lands in the requested output dir when there is one.
   */
  private async collect(record: Record_, jobDir: string, draft: ArtifactDraft): Promise<void> {
    const artifactId = `${record.snapshot.artifacts.length + 1}`;
    const taken = new Set(record.snapshot.artifacts.map((item) => item.name));
    const name = dedupe(draft.name, taken);
    const staged = join(jobDir, safeName(name));
    await writeFile(staged, draft.bytes);

    const artifact: OutputFile = {
      id: artifactId,
      name,
      kind: draft.kind as FileKind,
      sizeBytes: draft.bytes.byteLength,
      page: draft.page,
      sourceFileId: draft.sourceFileId,
      path: staged,
    };

    const dir = record.request.output?.dir;
    if (dir) {
      const finalName = await freeName(dir, name);
      const target = join(dir, safeName(finalName));
      await ensureDir(dir);
      await writeFile(target, draft.bytes);
      artifact.name = finalName;
      artifact.path = target;
    }
    const wantBytes = record.request.output?.wantBytes || !dir;
    if (wantBytes && draft.bytes.byteLength <= MAX_INLINE_BYTES) {
      artifact.dataBase64 = Buffer.from(draft.bytes).toString('base64');
    }

    record.artifactPaths.set(artifactId, staged);
    record.snapshot.artifacts.push(artifact);
  }

  private emitJob(snapshot: JobSnapshot): void {
    const event: EngineEvent = { event: 'job.updated', job: clone(snapshot) };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        logger.error('event listener failed', { error: String(error) });
      }
    }
  }
}

function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 160) || 'output.pdf';
}

/** Never silently overwrite a previous run's output in the same folder. */
async function freeName(dir: string, name: string): Promise<string> {
  const taken = new Set<string>();
  let candidate = name;
  for (;;) {
    const exists = await stat(join(dir, candidate)).then(() => true, () => false);
    if (!exists) return candidate;
    taken.add(candidate);
    candidate = dedupe(name, taken);
  }
}

function updateProgress(snapshot: JobSnapshot, progress: Partial<JobSnapshot['progress']>): void {
  snapshot.progress = { ...snapshot.progress, ...progress };
}

function finish(snapshot: JobSnapshot, progress: Partial<JobSnapshot['progress']>): void {
  updateProgress(snapshot, progress);
}

function isTerminal(snapshot: JobSnapshot | undefined): boolean {
  if (!snapshot) return true;
  return ['succeeded', 'failed', 'cancelled'].includes(snapshot.progress.state);
}

/** Drops base64 payloads from snapshots pushed over the event channel. */
function clone(snapshot: JobSnapshot): JobSnapshot {
  return {
    ...snapshot,
    fileNames: [...snapshot.fileNames],
    artifacts: snapshot.artifacts.map(({ dataBase64, ...rest }) => rest),
    warnings: [...snapshot.warnings],
  };
}

export function fileStem(name: string): string {
  return baseName(name);
}
