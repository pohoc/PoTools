/**
 * PoTools Windows 7 兼容壳的静态服务器（从 main.js 拆出，方便用 node:http
 * 直接跑边界测试；main.js 只保留 Electron 生命周期）。
 *
 * 安全边界（WIN-01）：只伺服 dist 内的文件。判定用 `path.relative`，不再用
 * `file.startsWith(dist)`——同前缀的兄弟目录（`dist-other`）同样能通过
 * startsWith，等于把 dist 之外的文件当成站内资源；另外 URL 上的
 * `decodeURIComponent` 对畸形百分号编码（`%zz`）会抛异常，未捕获时整个请求
 * 处理函数崩溃，现在统一回 400。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * 把请求 URL 解析成 dist 内的绝对路径。
 *
 * 返回值要么是 `{ file }`，要么是 `{ status, reason }`（受控的 4xx，不抛异常）。
 * `#hash` 不会出现在 origin-form 请求里，但一并剥掉以免把片段当成路径。
 */
function resolveStaticFile(dist, url) {
  const root = path.resolve(dist);
  const target = String(url ?? '/').split('?')[0].split('#')[0];
  let decoded;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    return { status: 400, reason: 'malformed percent-encoding' };
  }
  if (!decoded.startsWith('/')) {
    return { status: 400, reason: 'request target must be an absolute path' };
  }
  if (decoded.includes('\0')) {
    return { status: 400, reason: 'request target contains a NUL byte' };
  }
  const relativeTarget = decoded.slice(1);
  const file = path.resolve(root, relativeTarget === '' ? 'index.html' : relativeTarget);
  const withinRoot = path.relative(root, file);
  const escapes =
    withinRoot === '' ||
    withinRoot === '..' ||
    withinRoot.startsWith('..' + path.sep) ||
    path.isAbsolute(withinRoot);
  if (escapes) {
    return { status: 403, reason: 'path escapes the served directory' };
  }
  return { file };
}

/**
 * 只伺服 dist 内的文件；找不到的路径回退 index.html（哈希路由其实到不了这里，
 * 兜底防手输路径）。端口交给系统分配（listen(0)），调用方从 address() 取。
 */
function startServer(dist) {
  const index = () => path.resolve(dist, 'index.html');
  const server = http.createServer((req, res) => {
    const resolved = resolveStaticFile(dist, req.url);
    if (resolved.status) {
      res.writeHead(resolved.status, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(resolved.reason);
    }
    fs.readFile(resolved.file, (err, data) => {
      if (err) {
        return fs.readFile(index(), (indexErr, fallback) => {
          if (indexErr) {
            res.writeHead(404);
            return res.end();
          }
          res.writeHead(200, { 'Content-Type': MIME['.html'] });
          res.end(fallback);
        });
      }
      const type = MIME[path.extname(resolved.file).toLowerCase()] ?? 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type });
      res.end(data);
    });
  });
  server.listen(0, '127.0.0.1');
  return server;
}

module.exports = { startServer, resolveStaticFile, MIME };
