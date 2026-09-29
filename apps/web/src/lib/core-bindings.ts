/**
 * The single host-side binding to the Rust core WASM runtime. Engine behavior
 * executes in Rust only; this module forwards calls after `installRustCore`
 * and owns the installed catalog. Types live in `core-contract.ts`.
 */
import type {
  FieldValue,
  IdPhotoSize,
  PasswordStrengthAssessment,
  RustCoreRuntime,
  ToolDescriptor,
  ToolField,
  ToolId,
} from './core-contract.ts';

export const PROTOCOL_VERSION = 1;

let runtime: RustCoreRuntime | undefined;

export function installRustCore(value: RustCoreRuntime): void {
  runtime = value;
}

export function rustCore(): RustCoreRuntime {
  if (!runtime) throw new Error('Rust Core WASM 尚未初始化');
  return runtime;
}

export function fieldsOf(list: ToolField[]): Record<string, FieldValue> {
  return rustCore().fieldsOf(list) as Record<string, FieldValue>;
}

export function visibleFields(list: ToolField[], values: Record<string, FieldValue>): ToolField[] {
  const selected = new Set(rustCore().visibleFields(list, values).map((field) => (field as ToolField).key));
  return list.filter((field) => selected.has(field.key));
}

export class PageRangeError extends Error {
  constructor(message: string) { super(message); this.name = 'PageRangeError'; }
}

export function parsePageRanges(input: string, pageCount: number): number[] {
  try { return rustCore().parsePageRanges(input, pageCount); }
  catch (error) { throw new PageRangeError(String(error).replace(/^Error:\s*/, '')); }
}

export function formatPageRanges(pages: number[]): string { return rustCore().formatPageRanges(pages); }

export function isValidPageRanges(input: string): boolean {
  return rustCore().isValidPageRanges(input);
}

export function assessPasswordStrength(password: string): PasswordStrengthAssessment {
  return rustCore().assessPasswordStrength(password);
}

export function getIdPhotoSize(id: unknown): IdPhotoSize {
  const { id: _id, ...size } = rustCore().idPhotoSize(typeof id === 'string' ? id : undefined);
  return size;
}

export function getIdPhotoPrintSize(id: unknown): { width: number; height: number } {
  return rustCore().idPhotoPrintSize(typeof id === 'string' ? id : undefined);
}

/** Populated from Rust before the browser or Worker begins dispatching. */
export const TOOL_LIST: ToolDescriptor[] = [];
export const TOOLS = {} as Record<ToolId, ToolDescriptor>;

export function installToolCatalog(): void {
  const descriptors = rustCore().allTools() as ToolDescriptor[];
  TOOL_LIST.splice(0, TOOL_LIST.length, ...descriptors);
  for (const key of Object.keys(TOOLS) as ToolId[]) delete TOOLS[key];
  for (const tool of descriptors) TOOLS[tool.id] = tool;
}

export function defaultOptions(id: ToolId): Record<string, FieldValue> {
  return fieldsOf(TOOLS[id].fields);
}
