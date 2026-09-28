# Worker 运行架构

PoTools 桌面端使用 WebView Worker 执行文件和工具任务，Tauri/Rust host 提供需要访问本机文件系统、系统网络和目录归档的能力。应用发行包不携带 Node 引擎或 sidecar。

## 执行路径

- UI 通过统一 RPC 调用内嵌 Worker dispatcher；未接入 Worker 或宿主的能力以明确错误返回。
- 注册表覆盖 97 个 Worker 工具；`invoice-organize` 由 Worker 扫描与识别、Rust host 归档能力共同实现。
- Worker 池支持 1–4 个并发线程。每个线程独立处理一个调用；任务取消会终止对应线程并补充新线程。
- 文件输入缓冲区以 transferable 方式交给 Worker；桌面端生成的二进制产物通过 Tauri 原始 IPC body 写入临时目录或用户指定目录。

## 验证

- `pnpm --filter @potools/desktop typecheck`
- `pnpm --filter @potools/desktop build`
- `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`
- `pnpm test:tools`：225 PASS、0 FALLBACK、0 DIFF、0 CRASH、1 KNOWN / 226 项。
- `git diff --check`

唯一已知 golden 差异为 `ocr-table` 对无表格矢量 PDF 的行为：浏览器 OCR 输出单列文本，旧 Node 基准返回 `empty_selection`。此行为已登记为 `KNOWN_DIVERGENCES`。

上述构建和 golden 验证在当前 macOS/Chromium 环境完成。Windows WebView 与 Linux 原生发行包仍需在对应平台完成安装和运行验证；Linux 容器构建命令见仓库根目录 `scripts/build-linux-in-docker.sh`。
