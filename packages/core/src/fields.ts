/** Declarative option schema: one definition drives the UI form and engine validation. */

export type FieldSection = 'main' | 'layout' | 'advanced';

export interface ShowIf {
  field: string;
  in: Array<string | number | boolean>;
}

interface FieldCommon {
  key: string;
  labelKey: string;
  descriptionKey?: string;
  section?: FieldSection;
  showIf?: ShowIf;
  /** Fields sharing a row render side by side. */
  row?: string;
  /** Rendered in the UI but not consumed by the engine (e.g. presets). */
  uiOnly?: boolean;
}

export type ToolField =
  | (FieldCommon & {
      type: 'text';
      default: string;
      placeholderKey?: string;
      maxLength?: number;
      mono?: boolean;
      required?: boolean;
    })
  | (FieldCommon & {
      type: 'textarea';
      default: string;
      placeholderKey?: string;
      mono?: boolean;
      rows?: number;
      maxLength?: number;
      required?: boolean;
    })
  | (FieldCommon & {
      type: 'number';
      default: number;
      min?: number;
      max?: number;
      step?: number;
      suffixKey?: string;
      displayUnit?: 'mm';
    })
  | (FieldCommon & { type: 'boolean'; default: boolean })
  | (FieldCommon & {
      type: 'select';
      default: string | number;
      options: Array<{
        value: string | number;
        labelKey: string;
        descriptionKey?: string;
        /** Values written alongside this choice — used by UI-only presets. */
        applies?: Record<string, FieldValue>;
      }>;
      presentation?: 'position-grid' | 'cards';
    })
  | (FieldCommon & {
      type: 'slider';
      default: number;
      min: number;
      max: number;
      step: number;
      unit?: 'percent' | 'pt' | 'dpi' | 'px' | 'kb' | 'deg';
      displayUnit?: 'mm';
      presets?: Array<{ value: number; labelKey: string }>;
    })
  | (FieldCommon & { type: 'color'; default: string })
  | (FieldCommon & {
      type: 'timezone';
      default: string;
    })
  | (FieldCommon & {
      type: 'dateTime';
      default: string;
      placeholderKey?: string;
      mono?: boolean;
      required?: boolean;
      presets?: string[];
      /** False when the tool only reads the calendar part of the value. */
      allowTime?: boolean;
    })
  | (FieldCommon & {
      type: 'pageRanges';
      default: string;
      placeholderKey?: string;
      allowEmpty?: boolean;
      /** Disallow the all-pages token for destructive actions. */
      allowAll?: boolean;
    });

export type FieldValue = string | number | boolean;

export function fieldsOf(list: ToolField[]): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const f of list) out[f.key] = f.default;
  return out;
}

export function visibleFields(
  list: ToolField[],
  values: Record<string, FieldValue>,
): ToolField[] {
  return list.filter((f) => {
    if (!f.showIf) return true;
    return f.showIf.in.includes(values[f.showIf.field] as FieldValue);
  });
}
