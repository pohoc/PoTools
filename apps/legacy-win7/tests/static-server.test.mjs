/**
 * WIN-01: boundary tests for the Win7 shell's static file server.
 *
 * The guard used to be `file.startsWith(dist)`, which accepts a same-prefix
 * sibling directory (`dist-other`), and it ran `decodeURIComponent` on the raw
 * request target, which throws on malformed percent-encoding. Both are covered
 * below against a real `node:http` server, plus the behavior that legitimate
 * requests must keep (index, assets, SPA fallback).
 *
 * Plain `.mjs` on purpose: these assertions must run on every Node the repo
 * declares, with or without TypeScript type stripping.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { resolveStaticFile, startServer } from '../static-server.cjs';

const SECRET = 'SECRET-OUTSIDE-DIST';
let temporary;
let dist;
let server;
let port;

before(async () => {
  temporary = mkdtempSync(path.join(os.tmpdir(), 'potools-win7-static-'));
  dist = path.join(temporary, 'dist');
  mkdirSync(path.join(dist, 'assets'), { recursive: true });
  // A sibling directory that shares the `dist` prefix — the old startsWith()
  // guard treated files under it as if they were inside dist.
  mkdirSync(path.join(temporary, 'dist-other'), { recursive: true });
  writeFileSync(path.join(dist, 'index.html'), '<title>PoTools</title>', 'utf8');
  writeFileSync(path.join(dist, 'assets', 'app.js'), 'console.log(1);\n', 'utf8');
  writeFileSync(path.join(temporary, 'dist-other', 'secret.txt'), SECRET, 'utf8');

  server = startServer(dist);
  await new Promise((resolve) => server.once('listening', resolve));
  port = server.address().port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(temporary, { recursive: true, force: true });
});

/**
 * Send `requestTarget` verbatim. `http.get(urlString)` runs the target through
 * the WHATWG URL parser, which deletes `/../` segments before the request ever
 * reaches the server — precisely the case under test — so the raw `path` option
 * is used instead.
 */
function grab(requestTarget) {
  return new Promise((resolve, reject) => {
    // `agent: false` keeps every probe on its own socket: the global agent is
    // keep-alive since Node 19, so one rejected request would otherwise poison
    // the connections that follow it and show up as a timeout.
    const request = http.request(
      { host: '127.0.0.1', port, path: requestTarget, agent: false },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            type: response.headers['content-type'] ?? '',
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    request.setTimeout(5000, () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    request.end();
  });
}

test('legitimate requests keep serving index and assets', async () => {
  const index = await grab('/');
  assert.equal(index.status, 200);
  assert.match(index.type, /text\/html/);
  assert.match(index.body, /PoTools/);

  const asset = await grab('/assets/app.js');
  assert.equal(asset.status, 200);
  assert.equal(asset.type, 'text/javascript');

  const typed = await grab('/index.html');
  assert.equal(typed.status, 200);
  assert.equal(typed.body, '<title>PoTools</title>');
});

test('unknown routes still fall back to index.html (hash routing safety net)', async () => {
  const fallback = await grab('/some/unknown/route');
  assert.equal(fallback.status, 200);
  assert.match(fallback.body, /PoTools/);
  assert.ok(!fallback.body.includes(SECRET));
});

test('malformed percent-encoding answers 400 instead of throwing', async () => {
  const bad = await grab('/%zz.txt');
  assert.equal(bad.status, 400);
  // The handler must not have taken the socket down with it.
  const healthy = await grab('/');
  assert.equal(healthy.status, 200);

  for (const target of ['/%', '/%e0%41%41', '/a%2fb%zz']) {
    assert.equal((await grab(target)).status, 400, `${target} must be a controlled 400`);
  }
});

test('same-prefix sibling directory is outside the served root', async () => {
  const traversal = await grab('/../dist-other/secret.txt');
  assert.equal(traversal.status, 403);
  assert.ok(!traversal.body.includes(SECRET));
  // Exactly the case the old `file.startsWith(dist)` guard let through:
  // normalize(join(dist, '/../dist-other/secret.txt')) starts with dist.
  const legacy = path.join(dist, '..', 'dist-other', 'secret.txt');
  assert.ok(path.normalize(legacy).startsWith(dist), 'startsWith() would have accepted it');
  assert.equal(resolveStaticFile(dist, '/../dist-other/secret.txt').status, 403);
});

test('encoded and absolute-form traversal is rejected', async () => {
  const cases = [
    '/%2e%2e/dist-other/secret.txt',
    '/../%2e%2e/' + encodeURIComponent('etc/passwd'),
    '//etc/passwd',
    '/assets/../../dist-other/secret.txt',
    '/%00/../dist-other/secret.txt',
  ];
  for (const target of cases) {
    const response = await grab(target);
    assert.ok(
      response.status === 403 || response.status === 400,
      `${target} returned ${response.status}: ${response.body.slice(0, 60)}`,
    );
    if (response.status === 200) assert.ok(!response.body.includes(SECRET));
  }
  assert.equal(resolveStaticFile(dist, '//etc/passwd').status, 403);
  assert.equal(resolveStaticFile(dist, '/%2e%2e/dist-other/secret.txt').status, 403);
});

test('backslash targets never leak the sibling file on either platform', async () => {
  const response = await grab('/..\\dist-other\\secret.txt');
  assert.ok(response.status === 403 || response.status === 200 || response.status === 404);
  assert.ok(!response.body.includes(SECRET), `leaked via ${response.status}`);
});

test('resolver maps the root to index.html and keeps in-root paths inside', () => {
  const rootTarget = resolveStaticFile(dist, '/');
  assert.equal(rootTarget.file, path.resolve(dist, 'index.html'));
  const inside = resolveStaticFile(dist, '/assets/app.js?v=1');
  assert.equal(inside.file, path.resolve(dist, 'assets', 'app.js'));
  assert.equal(resolveStaticFile(dist, '/assets/app.js#frag').file, inside.file);
  assert.equal(resolveStaticFile(dist, 'index.html').status, 400);
});
