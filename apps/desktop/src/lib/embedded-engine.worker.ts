import { dispatchEmbeddedRpc } from '@potools/engine/browser';
import type { EmbeddedRpcRequest, InMemoryJobResult } from '@potools/engine/browser';
import type { JobSnapshot } from 'core';
import type { ResolvedInput } from '@potools/engine/browser';

interface RequestMessage {
  id: number;
  rpc?: EmbeddedRpcRequest;
  inputs?: ResolvedInput[];
  runtimeData?: Record<string, unknown>;
  cancelJobId?: string;
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<RequestMessage>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const worker = self as unknown as WorkerScope;
const cancelledJobs = new Set<string>();

worker.onmessage = async ({ data }) => {
  try {
    if (data.cancelJobId) {
      cancelledJobs.add(data.cancelJobId);
      return;
    }
    if (!data.rpc) throw new Error('缺少内嵌 RPC 请求');
    if (data.rpc.method === 'job.submit') {
      const request = data.rpc.params.job as { id?: string } | undefined;
      const jobId = request?.id ?? '';
      cancelledJobs.delete(jobId);
      const reply = await dispatchEmbeddedRpc(data.rpc, {
        inputs: data.inputs,
        onProgress: (snapshot) => {
        worker.postMessage({ id: data.id, progress: snapshot });
        },
        isCancelled: () => Boolean(jobId) && cancelledJobs.has(jobId),
        runtimeData: data.runtimeData,
      });
      const transfer: Transferable[] = (reply.jobResult?.artifacts ?? []).map((artifact) => artifact.bytes.buffer);
      worker.postMessage({ id: data.id, ...reply }, transfer);
      cancelledJobs.delete(jobId);
      return;
    }
    const reply = await dispatchEmbeddedRpc(data.rpc, { inputs: data.inputs, runtimeData: data.runtimeData });
    worker.postMessage({ id: data.id, ...reply });
  } catch (error) {
    const issue = error as Error & { code?: string; hintKey?: string };
    worker.postMessage({
      id: data.id,
      handled: true,
      error: {
        code: issue.code ?? 'internal',
        message: issue.message || String(error),
        hintKey: issue.hintKey,
      },
    });
  }
};
