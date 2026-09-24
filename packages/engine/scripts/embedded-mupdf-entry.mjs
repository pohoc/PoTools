import wasmBase64 from '../node_modules/mupdf/dist/mupdf-wasm.wasm';

globalThis.$libmupdf_wasm_Module = {
  wasmBinary: Buffer.from(wasmBase64, 'base64'),
  locateFile: () => 'inline:mupdf-wasm.wasm',
};

const mupdf = await import('mupdf');
export default mupdf.default;
