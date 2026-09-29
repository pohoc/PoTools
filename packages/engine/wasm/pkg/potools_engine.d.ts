/* tslint:disable */
/* eslint-disable */

export function coreAllTools(): any;

export function coreAssessPasswordStrength(password: string): any;

export function coreFieldsOf(fields: any): any;

export function coreFormatPageRanges(pages: any): string;

export function coreIdPhotoPrintSize(id?: string | null): any;

export function coreIdPhotoSize(id?: string | null): any;

export function coreIsValidPageRanges(input: string): boolean;

export function coreParsePageRanges(input: string, page_count: number): any;

export function coreVisibleFields(fields: any, values: any): any;

/**
 * Decodes an image for the browser OCR adapter: bytes in, `{ width, height,
 * rgba }` out (`rgba` is a `Uint8Array`; the adapter strips alpha to RGB).
 * `max_pixels` is the OCR pixel budget (the adapter passes 20e6).
 *
 * Rejections carry an error object (not a string) `{ code, message,
 * hintKey }` (same shape as the `error` field of `dispatch` replies, with
 * `hintKey: null` when absent): `unreadable_file` for unrecognized/corrupt
 * images, `unsupported` when the pixel budget is exceeded.
 */
export function decodeImageRgba(bytes: Uint8Array, max_pixels: number): any;

/**
 * Dispatches one in-memory tool request. Call from a dedicated Web Worker.
 */
export function dispatch(request: any): any;

/**
 * Builds the merged ocr-table XLSX workbook from adapter-side recognition
 * results.
 *
 * Request JSON: `{ inputs: [{ name, id?, pages: [{ page?, width?, lines:
 * [...] }] }], locale }`. Reply JSON: `{ ok, name?, bytes?, pages?, rows?,
 * warnings: [string], error?: { code, message, hintKey? } }`; `bytes`
 * serializes as a `Uint8Array`. `ok: false` carries `error` (e.g.
 * `empty_selection` with `hintKey: "error.noTable"`) plus any accumulated
 * warnings; only a malformed request rejects with `bad_request: …`.
 */
export function ocrTableWorkbook(request: any): any;

/**
 * Assembles ocr-text artifacts from adapter-side recognition results.
 *
 * Request JSON: `{ inputs: [{ name, id?, pages: [{ page?, width?, lines:
 * [{ text, confidence?, box? }] }] }], pageMarkers, locale }`.
 * Reply JSON: `{ artifacts: [{ name, text, inputId? }], warnings: [string],
 * empty: bool, pages: number, error?: { code, message, hintKey? } }` where
 * `text` already includes the trailing newline. Business errors (empty
 * selection) are reported in `error`, never as a rejected promise; only a
 * malformed request rejects with a `bad_request: …` string.
 */
export function ocrTextArtifacts(request: any): any;

export function parseInvoiceFields(text: string): any;

/**
 * Locates the drawable image regions of every page for the browser adapter
 * (ported `lib/pagedata.ts` `pageImageRects`). The adapter renders each
 * region with PDF.js at the tool's dpi and feeds the crops back through
 * `runtimeData.pdfImages` (keyed by page + rect index).
 *
 * Reply JSON: `{ pages: [{ page, width, height, rotation, rects: [[x, y, w,
 * h], ...] }] }` where `page` is 1-based, `width`/`height` are the visual
 * (post-rotation) page size in points, `rotation` is the normalized
 * `/Rotate` angle and every rect is in visual space with a top-left origin.
 * Rejections carry the error object `{ code, message, hintKey }` (same
 * shape as the `error` field of `dispatch` replies).
 */
export function pdfImageRects(bytes: Uint8Array): any;

/**
 * Renders an output file name from the shared naming pattern so web
 * adapters can preview names without duplicating the naming logic.
 */
export function renderToolName(pattern: string | null | undefined, name: string, tool: string, index: number, total: number, range: string | null | undefined, ext: string): string;

/**
 * Returns catalog tools routed by the Rust engine, including tools that
 * return a validation error when called without their required input.
 */
export function toolCapabilities(): any;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly coreAllTools: () => [number, number, number];
    readonly coreAssessPasswordStrength: (a: number, b: number) => [number, number, number];
    readonly coreFieldsOf: (a: any) => [number, number, number];
    readonly coreFormatPageRanges: (a: any) => [number, number, number, number];
    readonly coreIdPhotoPrintSize: (a: number, b: number) => [number, number, number];
    readonly coreIdPhotoSize: (a: number, b: number) => [number, number, number];
    readonly coreIsValidPageRanges: (a: number, b: number) => number;
    readonly coreParsePageRanges: (a: number, b: number, c: number) => [number, number, number];
    readonly coreVisibleFields: (a: any, b: any) => [number, number, number];
    readonly decodeImageRgba: (a: number, b: number, c: number) => [number, number, number];
    readonly dispatch: (a: any) => [number, number, number];
    readonly ocrTableWorkbook: (a: any) => [number, number, number];
    readonly ocrTextArtifacts: (a: any) => [number, number, number];
    readonly parseInvoiceFields: (a: number, b: number) => [number, number, number];
    readonly pdfImageRects: (a: number, b: number) => [number, number, number];
    readonly renderToolName: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => [number, number];
    readonly toolCapabilities: () => [number, number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
