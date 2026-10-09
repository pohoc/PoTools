import { installRustCore, installToolCatalog } from './core-bindings.ts';
import initWasm, * as wasm from '../../../../packages/engine/wasm/pkg/potools_engine.js';

let ready: Promise<void> | undefined;

/** Initializes the Rust Core bindings once per browser or Worker context. */
export function ensureRustCore(): Promise<void> {
  ready ??= initWasm().then(() => {
    installRustCore({
      allTools: wasm.coreAllTools,
      fieldsOf: wasm.coreFieldsOf,
      visibleFields: wasm.coreVisibleFields,
      parsePageRanges: wasm.coreParsePageRanges,
      formatPageRanges: wasm.coreFormatPageRanges,
      isValidPageRanges: wasm.coreIsValidPageRanges,
      assessPasswordStrength: wasm.coreAssessPasswordStrength,
      idPhotoSize: wasm.coreIdPhotoSize,
      idPhotoPrintSize: wasm.coreIdPhotoPrintSize,
      parseInvoiceFields: wasm.parseInvoiceFields,
    });
    installToolCatalog();
  }).catch((error: unknown) => {
    ready = undefined;
    throw error;
  });
  return ready;
}
