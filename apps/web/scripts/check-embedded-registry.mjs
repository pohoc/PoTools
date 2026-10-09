import { readFileSync } from 'node:fs';
const rustWasm = await import('../../../packages/engine/wasm/pkg/potools_engine.js');
await rustWasm.default({ module_or_path: readFileSync(new URL('../../../packages/engine/wasm/pkg/potools_engine_bg.wasm', import.meta.url)) });
const capabilities = rustWasm.toolCapabilities();
if (!Array.isArray(capabilities) || capabilities.length === 0) {
  throw new Error('Rust engine returned no tool capabilities');
}
const smoke = rustWasm.dispatch({ tool: 'json-format', options: { input: '{}' }, locale: 'zh-CN' });
if (!smoke.handled || !smoke.result?.text?.startsWith('{}')) {
  throw new Error(`Rust Worker startup smoke check failed: ${JSON.stringify(smoke)}`);
}
console.log(`[rust-engine] loaded ${capabilities.length} Rust tool capabilities and dispatched tool.run`);
