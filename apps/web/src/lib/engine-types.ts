import type { FileKind, JobSnapshot, RpcMethodName } from 'core';

export interface ResolvedInput {
  id: string;
  name: string;
  path: string | null;
  bytes: Uint8Array;
}

export interface EmbeddedRpcRequest {
  method: RpcMethodName;
  params: Record<string, unknown>;
}

export interface InMemoryJobResult {
  handled: boolean;
  snapshot?: JobSnapshot;
  artifacts?: Array<{
    id: string;
    name: string;
    kind: FileKind;
    bytes: Uint8Array;
    sourceFileId?: string;
  }>;
}
