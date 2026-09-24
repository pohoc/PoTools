import type { JobSnapshot, RpcMethodName } from 'core';
import type { EmbeddedRpcRequest, InMemoryJobResult, ResolvedInput } from '@potools/engine/browser';
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
}

interface ResponseMessage {
  id: number;
  handled?: boolean;
  result?: unknown;
  jobResult?: InMemoryJobResult;
  progress?: JobSnapshot;
  error?: { code: string; message: string; hintKey?: string };
}

let worker: Worker | null = null;
let sequence = 0;
const pending = new Map<number, PendingCall>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./embedded-engine.worker.ts', import.meta.url), { type: 'module' });
  worker.addEventListener('message', (event: MessageEvent<ResponseMessage>) => {
    const response = event.data;
    const call = pending.get(response.id);
    if (!call) return;
    if (response.progress) {
      call.onProgress?.(response.progress);
      return;
    }
    pending.delete(response.id);
    if (response.error) {
      call.reject(new RpcError(response.error.code, response.error.message, response.error.hintKey));
    } else {
      call.resolve({ handled: response.handled === true, result: response.result, jobResult: response.jobResult });
    }
  });
  worker.addEventListener('error', (event) => {
    const error = new Error(event.message || '内嵌工具线程启动失败');
    for (const call of pending.values()) call.reject(error);
    pending.clear();
    worker?.terminate();
    worker = null;
  });
  return worker;
}

export function callEmbeddedRpc(
  method: RpcMethodName,
  params: Record<string, unknown>,
  options: { inputs?: ResolvedInput[]; onProgress?: (snapshot: JobSnapshot) => void; runtimeData?: Record<string, unknown> } = {},
): Promise<WorkerReply> {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, {
      resolve,
      reject,
      onProgress: options.onProgress,
    });
    const inputs = options.inputs;
    getWorker().postMessage(
      { id, rpc: { method, params }, inputs, runtimeData: options.runtimeData },
      inputs?.map((input) => input.bytes.buffer as ArrayBuffer) ?? [],
    );
  });
}

export function cancelEmbeddedFileJob(jobId: string): void {
  worker?.postMessage({ id: ++sequence, cancelJobId: jobId });
}
