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
    /** Present when the artifact still needs JS-side staging (wasm path, or a native run without a temp root). */
    bytes?: Uint8Array;
    /** Set when the desktop command already wrote the artifact to the temp dir; no bytes cross the bridge. */
    stagedPath?: string;
    outputPath?: string | null;
    sourceFileId?: string;
  }>;
}
