import { createServer } from 'vite';

const server = await createServer({
  configFile: 'vite.config.ts',
  logLevel: 'error',
  server: { middlewareMode: true },
  appType: 'custom',
});

try {
  const [browser, registry, catalog] = await Promise.all([
    server.ssrLoadModule('../../packages/engine/src/browser.ts'),
    server.ssrLoadModule('../../packages/engine/src/embedded-registry.ts'),
    server.ssrLoadModule('../../packages/core/src/tools.ts'),
  ]);
  const registered = new Set([
    ...Object.keys(registry.embeddedTextToolImplementations),
    ...Object.keys(registry.embeddedFileToolImplementations),
  ]);
  const hostRouted = new Set(['invoice-organize']);
  const missing = catalog.TOOL_LIST.map(({ id }) => id)
    .filter((id) => !registered.has(id) && !hostRouted.has(id));

  if (missing.length) {
    throw new Error(`Catalog tools are missing from embedded registry or host routes: ${missing.join(', ')}`);
  }

  const smoke = await browser.dispatchEmbeddedRpc({
    method: 'tool.run',
    params: { tool: 'json-format', options: { input: '{}' }, globals: { locale: 'zh-CN' } },
  });
  if (!smoke.handled || !smoke.result?.text?.startsWith('{}')) {
    throw new Error(`Embedded RPC startup smoke check failed: ${JSON.stringify(smoke)}`);
  }

  console.log(`[embedded-registry] loaded ${registered.size} Worker tools, ${hostRouted.size} host-routed catalog tools, and dispatched tool.run`);
} finally {
  await server.close();
}
