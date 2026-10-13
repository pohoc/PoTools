import type { FileKind, JobSnapshot, RpcMethodName } from 'core';

export interface ResolvedInput {
  id: string;
  name: string;
  path: string | null;
  bytes: Uint8Array;
  /**
   * Size of the file on disk, carried for inputs that stay on disk (a native job
   * never needs their bytes in JS). The job summary reports input volume from
   * this when `bytes` is deliberately empty; `0` means "not read, not known".
   */
  sizeBytes?: number;
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
