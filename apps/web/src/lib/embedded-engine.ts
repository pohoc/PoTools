import type { JobSnapshot, RpcMethodName } from 'core';
import { now } from './timing.ts';
import type { InMemoryJobResult, ResolvedInput } from './engine-types.ts';
import { RpcError } from './transport.ts';

export interface WorkerReply {
  handled: boolean;
  result?: unknown;
  jobResult?: InMemoryJobResult;
}

interface PendingCall {
  resolve(value: WorkerReply): void;
  reject(error: Error): void;
  onProgress?: (snapshot: JobSnapshot) => void;
  jobId?: string;
  slot?: WorkerSlot;
  dispatch: () => void;
}
interface ResponseMessage {
  id: number;
  handled?: boolean;
  result?: unknown;
  jobResult?: InMemoryJobResult;
  progress?: JobSnapshot;
  error?: { code: string; message: string; hintKey?: string };
}
interface WorkerSlot {
  worker: Worker;
  activeCallId: number | null;
  activeJobId: string | null;
  retiring: boolean;
}

let slots: WorkerSlot[] = [];
let sequence = 0;
let desiredSize = 1;
const pending = new Map<number, PendingCall>();
const queued: number[] = [];

function dispatchNext(slot: WorkerSlot): void {
  if (slot.activeCallId !== null) return;
  if (slot.retiring) {
    slot.worker.terminate();
    slots = slots.filter((item) => item !== slot);
    return;
  }
  while (queued.length) {
    const id = queued.shift();
    if (id === undefined) return;
    const call = pending.get(id);
    if (!call) continue;
    call.slot = slot;
    slot.activeCallId = id;
    slot.activeJobId = call.jobId ?? null;
    call.dispatch();
    return;
  }
}

function replaceWorker(slot: WorkerSlot, error?: Error): void {
  const id = slot.activeCallId;
  if (id !== null) {
    const call = pending.get(id);
    if (call) {
      pending.delete(id);
      call.reject(error ?? new RpcError('cancelled', '任务已取消'));
    }
  }
  slot.worker.terminate();
  slot.worker = createWorker(slot);
  slot.activeCallId = null;
  slot.activeJobId = null;
  dispatchNext(slot);
}

function createWorker(slot: WorkerSlot): Worker {
  const worker = new Worker(new URL('./embedded-engine.worker.ts', import.meta.url), { type: 'module' });
  worker.addEventListener('message', (event: MessageEvent<ResponseMessage>) => {
    const response = event.data;
    const call = pending.get(response.id);
    if (!call) return;
    if (response.progress) {
      call.onProgress?.(response.progress);
      return;
    }
    pending.delete(response.id);
    if (slot.activeCallId === response.id) {
      slot.activeCallId = null;
      slot.activeJobId = null;
      dispatchNext(slot);
    }
    if (response.error) call.reject(new RpcError(response.error.code, response.error.message, response.error.hintKey));
    else call.resolve({ handled: response.handled === true, result: response.result, jobResult: response.jobResult });
  });
  worker.addEventListener('error', (event) => {
    // A worker that dies with a message of its own still carries that specific
    // text; one that dies silently only had this Chinese fallback, so give that
    // case a code the tables can resolve.
    replaceWorker(
      slot,
      event.message ? new Error(event.message) : new RpcError('workerCrash', '内嵌工具线程异常退出'),
    );
  });
  return worker;
}

function resizePool(size: number): void {
  desiredSize = Math.min(4, Math.max(1, Math.trunc(size) || 1));
  while (slots.filter((slot) => !slot.retiring).length < desiredSize) {
    const slot: WorkerSlot = { worker: null as unknown as Worker, activeCallId: null, activeJobId: null, retiring: false };
    slot.worker = createWorker(slot);
    slots.push(slot);
  }
  const activeSlots = slots.filter((slot) => !slot.retiring);
  if (activeSlots.length > desiredSize) {
    const excess = activeSlots.length - desiredSize;
    for (const slot of activeSlots.slice(-excess)) {
      if (slot.activeCallId === null) {
        slot.worker.terminate();
        slots = slots.filter((item) => item !== slot);
      } else {
        slot.retiring = true;
      }
    }
  }
}

export function configureEmbeddedWorkerPool(size: number): void {
  resizePool(size);
}

export function embeddedWorkerCount(): number {
  return desiredSize;
}

/**
 * Bytes of a File-backed input, cached per file.
 *
 * `arrayBuffer()` on the user's file used to run for **every** request, and a
 * 47 MB scan made that the dominant cost of merely *opening* a document: the page
 * grid asks for thumbnails in several batches, so the same file was read from
 * scratch each time (~6 s per batch, measured, while the render itself was
 * ~0.4 s). Resulting buffers are handed out as a fresh copy because the buffer is
 * transferred — and therefore detached — to the worker.
 */
const INPUT_BYTES = new WeakMap<Blob, Uint8Array>();

async function materializeInput(input: ResolvedInput): Promise<Uint8Array> {
  if (input.bytes.byteLength) return input.bytes;
  const file = (input as ResolvedInput & { file?: File }).file;
  if (!file) return input.bytes;
  // Keyed by the File itself, not by `input.id`: the id is generated per
  // `toFileRef` call, so an id-based key missed on every request and the 47 MB
  // was still read once per batch. A File also keys the cache's lifetime for
  // free, so nothing is retained once the pick is gone.
  let cached = INPUT_BYTES.get(file);
  if (!cached) {
    cached = new Uint8Array(await file.arrayBuffer());
    INPUT_BYTES.set(file, cached);
  }
  return cached.slice();
}

function makeDispatch(id: number, method: RpcMethodName, params: Record<string, unknown>, options: {
  inputs?: ResolvedInput[];
  runtimeData?: Record<string, unknown>;
}, slot: WorkerSlot): () => void {
  return () => {
    // Splits the request into "read the bytes" and "the worker round trip", which
    // the transport-level timing above cannot tell apart: it only sees the total,
    // and an unchanged total after a caching change means the read was not the
    // cost at all. `cacheHits` also reveals whether each request really reuses the
    // same File instance.
    const prepareAt = now();
    let cacheHits = 0;
    let cacheMisses = 0;
    void Promise.all((options.inputs ?? []).map(async (input) => {
      const file = (input as ResolvedInput & { file?: File }).file;
      const wasCached = file ? INPUT_BYTES.has(file) : false;
      const bytes = await materializeInput(input);
      if (file) {
        if (wasCached) cacheHits += 1;
        else cacheMisses += 1;
      }
      return { input: { ...input, path: input.path ?? null, bytes }, transfer: bytes.buffer as ArrayBuffer };
    })).then((prepared) => {
      console.info('PoTools⏱ dispatch:prepare', {
        method,
        bytes: prepared.reduce((sum, entry) => sum + entry.input.bytes.byteLength, 0),
        materializeMs: Math.round(now() - prepareAt),
        cacheHits,
        cacheMisses,
      });
      if (!pending.has(id)) return;
      try {
        slot.worker.postMessage(
          { id, rpc: { method, params }, inputs: prepared.map(({ input }) => input), runtimeData: options.runtimeData },
          prepared.map(({ transfer }) => transfer),
        );
      } catch (error) {
        const call = pending.get(id);
        if (!call) return;
        pending.delete(id);
        slot.activeCallId = null;
        slot.activeJobId = null;
        call.reject(error instanceof Error ? error : new Error(String(error)));
        dispatchNext(slot);
      }
    }).catch((error: unknown) => {
      const call = pending.get(id);
      if (!call) return;
      pending.delete(id);
      slot.activeCallId = null;
      slot.activeJobId = null;
      call.reject(error instanceof Error ? error : new Error(String(error)));
      dispatchNext(slot);
    });
  };
}

export function callEmbeddedRpc(
  method: RpcMethodName,
  params: Record<string, unknown>,
  options: { inputs?: ResolvedInput[]; onProgress?: (snapshot: JobSnapshot) => void; runtimeData?: Record<string, unknown> } = {},
): Promise<WorkerReply> {
  resizePool(desiredSize);
  const id = ++sequence;
  const job = method === 'job.submit' ? params.job as { id?: string } | undefined : undefined;
  return new Promise((resolve, reject) => {
    const call: PendingCall = {
      resolve,
      reject,
      onProgress: options.onProgress,
      jobId: job?.id,
      dispatch: () => {},
    };
    call.dispatch = () => {
      if (!call.slot) return;
      makeDispatch(id, method, params, options, call.slot)();
    };
    pending.set(id, call);
    queued.push(id);
    for (const slot of slots) dispatchNext(slot);
  });
}

export function cancelEmbeddedFileJob(jobId: string): boolean {
  const queuedIndex = queued.findIndex((id) => pending.get(id)?.jobId === jobId);
  if (queuedIndex >= 0) {
    const id = queued.splice(queuedIndex, 1)[0];
    const call = id === undefined ? undefined : pending.get(id);
    if (id !== undefined) pending.delete(id);
    call?.reject(new RpcError('cancelled', '任务已取消'));
    return true;
  }
  const slot = slots.find((item) => item.activeJobId === jobId);
  if (!slot) return false;
  const id = slot.activeCallId;
  const call = id === null ? undefined : pending.get(id);
  if (id !== null) pending.delete(id);
  slot.worker.terminate();
  slot.worker = createWorker(slot);
  slot.activeCallId = null;
  slot.activeJobId = null;
  call?.resolve({ handled: true });
  dispatchNext(slot);
  return true;
}

export function shutdownEmbeddedWorkerPool(): void {
  const error = new RpcError('cancelled', '引擎已停止');
  for (const call of pending.values()) call.reject(error);
  pending.clear();
  queued.length = 0;
  for (const slot of slots) slot.worker.terminate();
  slots = [];
}
