/**
 * PoTools Windows 7 兼容壳（Electron 22 / Chromium 108）。
 *
 * 设计：主进程内嵌一个只绑定 127.0.0.1 的静态服务器伺服 dist，窗口加载
 * http://127.0.0.1:<随机端口>——Web UI 里的 fetch（字体、OCR 模型、pdf.js
 * worker）全部同源可用；渲染进程无 Node（contextIsolation + sandbox），
 * 攻击面与浏览器模式一致。
 *
 * 功能边界：这是浏览器模式功能集（引擎全在 wasm/worker 内本地运行），桌面
 * 专属能力（发票整理、系统打印、打开所在目录）在此壳中不可用。
 * Win7 依赖链注意：Electron 22 / Chromium 108 是最后支持 Win7 的版本，且均
 * 已 EOL——本壳只为存量 Win7 机器提供过渡方案。
 */
const { app, BrowserWindow, shell } = require('electron');
const path = require('node:path');
const { startServer } = require('./static-server.cjs');

const DIST = path.join(__dirname, 'dist');

app.whenReady().then(() => {
  const server = startServer(DIST);
  server.on('listening', () => {
    const port = server.address().port;
    const win = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 960,
      minHeight: 600,
      title: 'PoTools',
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    // 外链交给系统默认程序；壳内不再开新窗口。
    win.webContents.setWindowOpenHandler(({ url: target }) => {
      if (/^https?:|^mailto:/i.test(target)) shell.openExternal(target);
      return { action: 'deny' };
    });
    win.loadURL(`http://127.0.0.1:${port}/`);
    // --selftest：自动化验证用——页面加载完成即退出码 0。
    if (process.argv.includes('--selftest')) {
      win.webContents.on('did-finish-load', async () => {
        try {
          const title = await win.webContents.executeJavaScript('document.title');
          const tools = await win.webContents.executeJavaScript('(document.body.textContent.match(/\\d+ 项工具/) || [])[0] ?? ""');
          console.log(`[selftest] title=${title} tools=${tools}`);
          process.exitCode = title.includes('PoTools') ? 0 : 2;
        } catch (error) {
          console.error(`[selftest] failed: ${error}`);
          process.exitCode = 2;
        } finally {
          app.quit();
        }
      });
    }
  });
});

app.on('window-all-closed', () => app.quit());
