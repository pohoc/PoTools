import { PageRangeError, type JobError } from '@potools/core';

export type EngineErrorCode =
  | 'bad_request'
  | 'unknown_tool'
  | 'unreadable_file'
  | 'encrypted_document'
  | 'no_cjk_font'
  | 'no_rasterizer'
  | 'no_image_codec'
  | 'empty_selection'
  | 'bad_page_range'
  | 'write_failed'
  | 'cancelled'
  | 'unsupported'
  | 'internal';

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly hintKey?: string;

  constructor(code: EngineErrorCode, message: string, hintKey?: string) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.hintKey = hintKey;
  }

  toJobError(): JobError {
    return {
      code: this.code,
      message: this.message,
      details: this.hintKey ? { hintKey: this.hintKey } : undefined,
    };
  }
}

export function toJobError(error: unknown): JobError {
  if (error instanceof EngineError) return error.toJobError();
  if (error instanceof PageRangeError) {
    return { code: 'bad_page_range', message: error.message, details: { hintKey: 'error.badRange' } };
  }
  if (error instanceof Error) {
    const encrypted = /encrypt|password/i.test(error.message);
    return { code: encrypted ? 'encrypted_document' : 'internal', message: error.message };
  }
  return { code: 'internal', message: String(error) };
}
