/**
 * Web-side type contract for the Rust core. Types only — the runtime bridge
 * lives in `core-bindings.ts` and engine behavior lives in Rust.
 */
import type { FileKind, ToolCategory, ToolId } from './core-protocol.ts';

export * from './core-protocol.ts';

export type FieldValue = string | number | boolean;

export type FieldSection = 'main' | 'layout' | 'advanced';
export interface ShowIf { field: string; in: Array<string | number | boolean> }
interface FieldCommon {
  key: string; labelKey: string; descriptionKey?: string; section?: FieldSection;
  showIf?: ShowIf; row?: string; uiOnly?: boolean;
}
export type ToolField =
  | (FieldCommon & { type: 'text'; default: string; placeholderKey?: string; maxLength?: number; mono?: boolean; required?: boolean; presets?: Array<{ value: string; labelKey: string }> })
  | (FieldCommon & { type: 'password'; default: string; placeholderKey?: string; maxLength?: number; required?: boolean; autoComplete?: 'new-password' | 'current-password' })
  | (FieldCommon & { type: 'textarea'; default: string; placeholderKey?: string; mono?: boolean; rows?: number; maxLength?: number; required?: boolean })
  | (FieldCommon & { type: 'number'; default: number; min?: number; max?: number; step?: number; suffixKey?: string; displayUnit?: 'mm' })
  | (FieldCommon & { type: 'boolean'; default: boolean })
  | (FieldCommon & { type: 'select'; default: string | number; options: Array<{ value: string | number; labelKey: string; descriptionKey?: string; applies?: Record<string, FieldValue> }>; presentation?: 'position-grid' | 'chips' })
  | (FieldCommon & { type: 'slider'; default: number; min: number; max: number; step: number; unit?: 'percent' | 'pt' | 'dpi' | 'px' | 'kb' | 'deg'; displayUnit?: 'mm'; presets?: Array<{ value: number; labelKey: string }> })
  | (FieldCommon & { type: 'color'; default: string })
  | (FieldCommon & { type: 'timezone'; default: string })
  | (FieldCommon & { type: 'dateTime'; default: string; placeholderKey?: string; mono?: boolean; required?: boolean; presets?: string[]; allowTime?: boolean })
  | (FieldCommon & { type: 'pageRanges'; default: string; placeholderKey?: string; allowEmpty?: boolean; allowAll?: boolean });

export type ToolLayout = 'standard' | 'organizer' | 'splitter' | 'metadata' | 'image-grid' | 'text';
/** Absent means 'action': only `live` re-runs automatically as the draft changes. */
export type ToolWorkflow =
  | 'page-management' | 'page-layout' | 'annotation' | 'conversion' | 'extraction'
  | 'optimization' | 'metadata' | 'image-processing' | 'invoice-organizing'
  | 'time' | 'crypto' | 'developer' | 'network' | 'finance';
export type ToolFormat = FileKind | 'image' | 'jpg' | 'png' | 'webp' | 'tiff';

/**
 * The task shape a tool's interface is built around
 * (`docs/standards/TOOL_INTERACTION.md` §1). Declared per tool in the catalog:
 * the main mode follows the user's task, never the presence of a `textarea`
 * field or a `layout: "text"` entry.
 */
export type ExperienceKind =
  | 'instant-transform'
  | 'structured-inspector'
  | 'calculator'
  | 'generator'
  | 'visual-editor'
  | 'batch-processor'
  | 'guided-workflow';

/** When a run is issued; kept separate from the kind (§2). */
export type ExecutionMode = 'live' | 'debounced' | 'manual';

export interface ToolExperience {
  kind: ExperienceKind;
  execution: ExecutionMode;
}

export interface ToolDescriptor {
  id: ToolId;
  nameKey: string;
  descKey: string;
  category: ToolCategory;
  workflow: ToolWorkflow;
  inputFormats: ToolFormat[];
  outputFormats: ToolFormat[];
  icon: string;
  order: number;
  accept: string;
  multiFile: boolean;
  layout: ToolLayout;
  fields: ToolField[];
  artifactKind: FileKind;
  requiresInput?: boolean;
  orderSensitive?: boolean;
  keywords?: string[];
  networkAccess?: 'network' | 'internet';
  experience: ToolExperience;
}

export type PasswordStrengthLevel = 'very-weak' | 'weak' | 'fair' | 'strong' | 'very-strong';
export type PasswordStrengthTip = 'length' | 'variety' | 'common' | 'repeated';
export interface PasswordStrengthAssessment {
  level: PasswordStrengthLevel; score: number; length: number; tips: PasswordStrengthTip[];
}

export interface IdPhotoSize {
  id?: string;
  labelKey: string;
  descriptionKey: string;
  widthMm: number;
  heightMm: number;
  width: number;
  height: number;
  dpi?: number;
  fileLabel: string;
}
export type IdPhotoSizeId = string;

export interface ResolvedPage { page: number }

/** Runtime functions supplied by the Rust/WASM core in browser contexts. */
export interface RustCoreRuntime {
  allTools(): unknown[];
  /** `{ toolId: 'native-file' | 'adapter' | 'engine' | 'unrouted' }` */
  hostRoutes(): Record<string, string>;
  fieldsOf(fields: unknown[]): Record<string, string | number | boolean>;
  visibleFields<T>(fields: T[], values: Record<string, string | number | boolean>): T[];
  parsePageRanges(input: string, pageCount: number): number[];
  formatPageRanges(pages: number[]): string;
  isValidPageRanges(input: string): boolean;
  assessPasswordStrength(password: string): PasswordStrengthAssessment;
  idPhotoSize(id?: string): IdPhotoSize;
  idPhotoPrintSize(id?: string): { width: number; height: number };
  parseInvoiceFields(text: string): {
    date: string; seller: string; buyer: string; invoiceNo: string; amount: string; type: string;
  };
}
