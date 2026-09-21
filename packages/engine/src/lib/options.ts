import type { FieldValue, ToolField } from '@potools/core';
import type { ToolDescriptor } from '@potools/core';
import { EngineError } from '../errors.ts';

/** Normalises whatever the UI sent into the typed values tools rely on. */
export function coerceOptions(
  descriptor: ToolDescriptor,
  raw: Record<string, unknown> | undefined,
): Record<string, FieldValue> {
  const values: Record<string, FieldValue> = {};
  for (const field of descriptor.fields) {
    values[field.key] = coerceValue(field, raw?.[field.key]);
  }
  // Tools such as the page organizer send structured data that has no field.
  const extras = ['plan', 'groups', 'readout', 'repairPng'] as const;
  for (const key of extras) {
    if (raw?.[key] !== undefined) values[key] = raw[key] as FieldValue;
  }
  return values;
}

function coerceValue(field: ToolField, value: unknown): FieldValue {
  if (value === undefined || value === null) return field.default;
  switch (field.type) {
    case 'number':
    case 'slider': {
      const parsed = typeof value === 'number' ? value : Number(String(value).replace(/[^\d.-]/g, ''));
      if (!Number.isFinite(parsed)) return field.default;
      const min = 'min' in field ? field.min : undefined;
      const max = 'max' in field ? field.max : undefined;
      return Math.min(Math.max(parsed, min ?? -Infinity), max ?? Infinity);
    }
    case 'boolean':
      return value === true || value === 'true' || value === 1 || value === '1';
    case 'select': {
      const allowed = field.options.map((option) => option.value);
      const numeric = typeof value === 'number';
      const match = allowed.find((candidate) =>
        typeof candidate === typeof value ? candidate === value : String(candidate) === String(value),
      );
      if (match === undefined) return field.default;
      return numeric && typeof match === 'number' ? match : (match as FieldValue);
    }
    case 'color': {
      const text = String(value);
      return /^#[0-9a-fA-F]{6}$/.test(text) ? text.toLowerCase() : field.default;
    }
    default:
      return String(value);
  }
}

export function str(values: Record<string, FieldValue>, key: string): string {
  return String(values[key] ?? '');
}

export function num(values: Record<string, FieldValue>, key: string): number {
  const parsed = Number(values[key]);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function bool(values: Record<string, FieldValue>, key: string): boolean {
  return values[key] === true;
}

export function requireText(values: Record<string, FieldValue>, key: string, label: string): string {
  const text = str(values, key).trim();
  if (!text) throw new EngineError('bad_request', `${label} 不能为空`);
  return text;
}

/** `#rrggbb` → 0-1 channels for pdf-lib's `rgb()`. */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return { r: 0, g: 0, b: 0 };
  const int = Number.parseInt(match[1] as string, 16);
  return { r: ((int >> 16) & 255) / 255, g: ((int >> 8) & 255) / 255, b: (int & 255) / 255 };
}
