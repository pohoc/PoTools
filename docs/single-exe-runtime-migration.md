# Windows 单 EXE 运行时迁移

> **状态：已终止（2026-09-28）。** 本文档记录的 node-embed 静态链接路线已被
> `docs/worker-only-migration-plan.md`（方案 A：全面 Worker 化）取代并实施完毕。
> Node 运行时已从发行包整体移除，单 EXE 嵌入不再需要。以下内容仅作历史调研记录。

## 目标

绿色版交付时只有一个架构对应的 `PoTools.exe`。主进程运行 Tauri UI；需要 Node 引擎时，由同一个 `PoTools.exe` 以内部参数启动隔离子进程。Node runtime、引擎 bundle 和必需运行时资产都必须随该 EXE 分发，不释放到磁盘，也不旁置 `node.exe` 或 `engine/` 目录。现有工具行为和 JSON-RPC 语义需要保持。

每个 Windows 架构仍分别构建一个 EXE（x64、x86）。启动前检查 WebView2；缺失时从微软下载 Evergreen Bootstrapper，在 `%TEMP%` 静默安装运行时并删除安装器，再启动应用。Windows 安装包也显式配置为下载 bootstrapper。运行时本身由系统共享维护。应用处理用户文件时创建的工作文件和输出文件属于工具数据，不是随包运行时。

## 当前阻碍

- `package:windows:*:build` 已切换为 `node-embed` feature，先生成 embedded engine bundle，再从 `POTOOLS_NODE_EMBED_SDK_ROOT/<target>` 读取架构 SDK；Windows portable ZIP 现在只收录 `PoTools.exe`。此改动尚未在真实 Windows MSVC 或完整 xwin 链接环境构建验证，SDK 缺失/闭包错误时必须构建失败，不能把结果当作可发行单 EXE。
- `packages/engine` 由 20 个工具模块组合，并由 `packages/engine/src/rpc.ts` 分发；其中大量通用逻辑调用 Node 文件系统、子进程和 Node 原生扩展。
- `sharp` 与 ONNX Runtime Node 绑定依赖本机动态加载。MuPDF.js 本身使用 WASM，可作为 Vite `frontendDist` 资源嵌入，并已用于浏览器 Worker；OCR 模型及 WASM 也以构建资产随前端嵌入。
- Node 官方 SEA 产物是 Node 可执行文件本身，不能直接注入现有 Tauri Rust EXE。SEA 可以携带 JavaScript/数据，但 native addon 仍须先写到文件再加载。Node v22.20.0 的官方 `node.gyp` 默认将 `libnode` 配置为静态库，并在 Windows Node 可执行文件链接规则中使用 `/WHOLEARCHIVE:libnode.lib`；因此 Windows 静态链接路线确实存在，但 `libnode.lib` 不是独立 SDK，Tauri 还必须纳入 Node GYP 的 V8/第三方静态库、编译定义、系统库和链接选项。Node C++ Embedder API 可运行内存中的脚本，但官方不保证跨主版本稳定。
- Tauri 的 `bundle.resources` 会把资源作为应用旁置文件打包，不会把这些资源变成可直接执行的进程内模块。

因此不能通过改 ZIP/NSIS 选项完成目标。统一 RPC 入口保持不变；Node 子进程改为父 EXE 自启动的内部模式，Node runtime 与引擎脚本必须由构建链接/注入到该 EXE。浏览器兼容的高负载逻辑继续放入 Vite Worker；文件系统、原始网络等特权操作由 Tauri Rust core 命令执行。Worker 仍是线程；Node 引擎按用户要求保留为隔离子进程。Windows 的 WebView2 仍由系统提供。

## Node 静态嵌入构建依据

- 已核对 Node.js v22.20.0 官方 `node.gyp`：默认 `node_shared=false`、`node_lib_target_name=libnode`、`node_intermediate_lib_type=static_library`；Windows 最终链接规则对 Node/V8 archive 使用 whole-archive，并列出 Dbghelp、Psapi、Winmm、Ws2_32 等系统依赖。这证明有可复用的官方静态链接构建配置，但不证明它可以仅靠添加一个 `libnode.lib` 就链接进 Tauri。
- Rust/Tauri 集成的目标结构是 `build.rs` 构建极薄 C ABI C++ bridge，Node/V8 C++ 类型和异常不越过 FFI；`main.rs` 在 WebView2/Tauri 初始化之前识别精确的 `--engine-child` 参数，调用 Node Embedder API 加载编译进 EXE 的 CommonJS engine bundle，并沿用现有 NDJSON stdio RPC。父进程从 `current_exe()` 启动自身，原有 `{id:"ready", result:...}` 握手和前端 RPC 契约不变。
- `node-embed` feature 已实现 `--engine-child` 分流、同 EXE 子进程启动、编译期 bundle 字节传递和 C ABI C++ bridge。新增 `scripts/build-node-embed-sdk.ps1` 与 `scripts/node-embed-manifest-exporter.cs`，按架构锁定 Node 源码版本，从成功的 MSBuild Link task 导出静态库闭包；无法归类为 Node 源码静态库或白名单 Windows 系统库的依赖会拒绝导出。该链尚未在 Windows/.NET/MSVC 环境执行，真实 binlog 结构、库闭包、链接和运行仍未验证。
- 已在 macOS xwin MSVC sysroot 下分别对 x64 与 x86 执行 feature-gated `cargo check --lib`，验证 Rust feature 和 C++ bridge 的目标编译；该检查使用临时空占位 `libnode.lib`，不包含真实 Node 实现且不会做最终链接。它不能证明 EXE 可链接、运行或无文件释放。
- 嵌入 bundle 已将 Sharp 切换为 `@img/sharp-wasm32` 并内嵌其 WASM；隔离工作目录下的引擎自检确认图片编解码可用。OCR 模型与 ONNX Runtime Web WASM 已内嵌，修正 factory 选择顺序后，隔离目录下的 `ocr-text` JSON-RPC 任务完成并生成文本。ONNX Runtime Node binding 仍 externalize，但嵌入 OCR 路径使用 Web WASM。完整工具能力及 Windows EXE 仍待验证。

## 当前构建准备

- `packages/engine` 的 `build:embedded` 由 `scripts/build-embedded.mjs` 驱动：生成独立 ESM 形态的 MuPDF+WASM bundle，再以 `data:` URL 内嵌到 CommonJS 引擎 bundle；Node 中 MuPDF 的 `import.meta.url` 固定到合成 file URL，不释放 JS/WASM 文件。Sharp WASM 及 ONNX Web WASM、OCR 模型/dictionary 以内存资产加入引擎 bundle。Sharp 在隔离 cwd 下通过自检，`ocr-text` 经 stdio JSON-RPC 完成并生成结果文件；`ocr-table` 在不含表格的样本上完成识别阶段后按原有空表格错误退出。该验证不证明 C++ Embedder、完整工具能力或 Windows EXE。
- Tauri crate 新增 opt-in `node-embed` feature：启用后，Windows 启动参数在 WebView2 检查前分流；父进程选择 `current_exe()` 启动 `--engine-child`，子进程通过 C ABI C++ shim 将编译期 bundle 字节交给 Node Embedder API。默认 feature 未启用时仍走现有 sidecar 路径。build.rs 会校验 SDK 架构及版本（x64 Node 22.20.0、x86 Node 20.20.2），要求 manifest whole-archive 静态 `libnode`，并链接 SDK 清单；SDK 导出脚本已添加，但未经 Windows 构建验证，feature 仍不能用于发行构建。
- C++ shim 已分别用 Node 22.20.0、20.20.2 官方头文件编译为目标文件；Tauri Rust crate 默认配置 `cargo check --lib` 通过。没有链接 Node 静态库，也没有 Windows 子进程或 JSON-RPC 运行验证；此项只是开始接通真实宿主入口，不是嵌入 PoC 验收。
- 下一步应在 Windows/.NET/MSVC 环境分别完成 x64 与 x86 SDK 导出，核对真实 Release link inputs 与依赖闭包，再产出可链接的 Tauri PoC。PoC 需由最终 Tauri EXE 自启动 `--engine-child`、从内存执行 bundle、完成 JSON-RPC 请求/退出；之后在目标 Windows 上对照全部工具行为和运行时文件布局。

## 迁移路线

1. **冻结接口契约**：记录 `RpcMethodName`、工具 ID、参数、结果、事件、错误码及并发/取消行为；现有 UI 继续使用同一契约。桌面端只调用一个 RPC 入口；统一 dispatcher 内部选择执行适配器。迁移按实现依赖分批是工程推进方式，不要求 UI 或工具页面逐个切换入口；全部工具迁完后移除兼容转发。
2. **单 EXE 子进程原型**：先验证 Tauri EXE 自启动 `--engine-child`，并在该子进程内运行编入同一 EXE 的 Node runtime；同时验证 x64/x86、stdio JSON-RPC 和无磁盘释放。原型通过前不移除现有 sidecar，避免破坏当前工具行为。
3. **纯计算工具**：迁移时间、金额、编码/加密等逻辑到 browser-safe 模块；Node built-ins 依赖改用 Web APIs 或 Rust commands。
4. **文件工具与任务队列**：迁移目录浏览、作业生命周期、工作区和结果交付；操作用户文件时只创建用户可见的工作/结果文件。
5. **文档、图像和 OCR**：复用可在 Worker 内运行的 MuPDF WASM；逐项替换 Sharp、Node ONNX 绑定及其他依赖文件路径的本机 API。模型和 WASM 作为 `frontendDist` 构建资产编入 EXE，通过应用内资源 URL 读取，不写出运行时文件。
6. **删除外置运行时**：移除发行包中的独立 `node.exe`、`engine/` 和 Node 原生模块复制；保留由同一 `PoTools.exe` 启动的内部 Node 子进程。
7. **发行验收**：x64/x86 分别构建；在干净 Windows 环境检查发行目录只含目标 EXE、运行时无新增应用依赖文件、引擎子进程映像路径与主程序相同，并按工具契约逐组核对行为。

## 当前仍依赖 sidecar 的主要工具组

- **文档导出**：`pdf-to-ofd` 的图像及文本模式都进入统一 Worker dispatcher。Tauri host 把显式配置字体或系统字体作为内存资源交给 Worker，按文档实际字形选择可用字体；不要求 UI 或工具页改入口。`pdf-to-word/ppt`、`pdf-to-excel`、`pdf-to-markdown/html/csv/rtf` 与含图片 EPUB 都已接入统一 Worker dispatcher。Word 和 EPUB 复用 PDF 版面模型、MuPDF WASM 渲染和共享图片区域裁切能力；画布或 OCR 不可用时相应功能仍会回退兼容引擎。PPT 沿用 MuPDF WASM 页面渲染、共享版面模型及浏览器兼容 PPTX 写入器；表格读取使用 PDF.js 文本位置，XLSX/EPUB/OFD 由共享 JSZip 写入器生成。未迁移格式及特定输入边界仍是 sidecar 边界。
- **文档导入**：`markdown-to-pdf` 的排版和 PDF 写入已接入统一 Worker dispatcher；Tauri host 将配置字体或系统字体、Markdown 相对图片读取为内存字节后交给 Worker，不让 Worker 访问路径。共享字体适配器检查字形覆盖，供 Markdown、PDF 转 OFD 和水印/页码/页眉页脚复用。无法读取的图片或缺少所需字体仍沿同一入口回退兼容引擎；更复杂的 Markdown 图片语法仍需继续纳入宿主契约。`ofd-to-pdf` 已接入统一 Worker dispatcher，可处理标准字集以及 OFD 内嵌字体；缺少内嵌字体且内容超出标准字集时，同一入口回退到使用系统字体的兼容引擎。
- **票据与目录操作**：`invoice-merge` 与 `invoice-organize` 已从 sidecar 迁出。扫描通过统一 RPC 入口触发 Rust 目录枚举和文件读取，Worker 使用内存 MuPDF WASM 提取 PDF 文本或计算 SHA-256；拼版、自动裁边和 PDF 归档也分别在 Worker/Rust host 内完成。归档和撤销由 Tauri/Rust host 执行，使用 SHA-256 校验、路径保护和撤销记录，不把 Node `fs` 留在 Worker。
- **公钥工具**：RSA 的 PEM/JWK 密钥生成与导入、OAEP（SHA-256/512）和 PKCS#1 v1.5 加解密、签名/验签、公钥导出及加密私钥处理已由同一 Worker dispatcher 实现。`x509` 的 RSA、常见命名曲线 EC（P-192/P-224/P-256/P-384/P-521、secp256k1 和 brainpool P-256/P-320/P-384/P-512）及 Ed25519 证书解析、链展示、扩展、SAN、指纹和 JSON 输出已接入；未识别的 EC 曲线仍回退兼容引擎。Web Crypto/worker 的平台限制仍按统一能力路由处理。
- **兼容边界**：这些组仍可通过现有 `{ method, params }` RPC 入口调用；当前 dispatcher 返回 `handled: false` 后，transport 才按原 RPC 回退 sidecar。TIFF 输出已改为 Worker 内 JPEG 压缩 TIFF；输出质量和图像像素仍需在目标 WebView 中做行为对照。当前 sidecar 是迁移期间的旁置 Node 兼容引擎，不是最终单 EXE 形态。

## 已迁移切片

- 2026-09-24：扩展内嵌 `x509` 对 EC（P-256/P-384/P-521）及 Ed/X 密钥族 SPKI 的识别与公钥 PEM 输出；未识别曲线仍保留兼容引擎回退。OpenSSL 生成的 P-256/P-384/P-521 与 Ed25519 证书均通过内嵌解析 smoke check；EC 摘要曲线名及行格式与旧 Node `KeyObject` 行为对齐，EC 样例的 AIA OCSP/caIssuers URI 可正常输出。Engine/desktop typecheck 和 `git diff --check` 通过。当前验证没有覆盖完整证书集，也没有在 Windows WebView 实测，因此不把这项记录视作单 EXE 验收。
- 2026-09-24：桌面 Worker 的 `tool.run` / `job.submit` 能力判定改为读取统一实现注册表 `packages/engine/src/embedded-registry.ts`，移除与实现表重复维护的文本/文件工具 ID 白名单。新增 Worker 实现只需注册一次，统一 RPC 入口据注册表确认是否有实现，再按选项和运行环境判断是否能在当前输入上执行；UI/RPC 契约不变。Engine typecheck、desktop typecheck/build 与 `git diff --check` 通过。Tauri 仍保留 sidecar 兼容回退，单 EXE 目标未完成。
- 2026-09-24：运行时加载发现内嵌注册表重复注册了 `metadata` 和 `crop`，会在 Worker 导入阶段抛错；移除 Node 版重复实现后，修正 crop 路由只注册浏览器实现。桌面 build 新增 registry 加载与工具目录覆盖检查，当前 97 个 Worker 工具及 1 个 Rust RPC 专用目录工具均可成功加载；重复 ID 或缺少实现会让 build 失败。桌面 production build 通过。
- 2026-09-24：嵌入式 Node bundle 将 OCR 的 Paddle 模型、字典和 ONNX Runtime Web WASM 编入 JS bundle，并让 `ocr.ts` 在嵌入模式从内存创建单线程 WASM session；常规 Node sidecar 仍使用原有模型目录和 ONNX Node Runtime。Engine typecheck、embedded bundle build 和 `git diff --check` 通过（bundle 7.2 MB）。隔离 cwd 的 JSON-RPC OCR smoke 已启动引擎并完成 ready，但在图像预处理阶段因 Sharp 仍为 external、当前环境无可加载的 Sharp runtime 而失败；因此内存 OCR/ONNX 端到端尚未验证，也说明 Sharp 必须先完成内嵌替代。
- 2026-09-24：OCR 的 Paddle 模型、字典与 ONNX Runtime Web WASM 已编入 bundle。之后 Sharp 改用内嵌 `@img/sharp-wasm32`：隔离 cwd 的 `engine selfcheck --json` 报告 `imageCodec:true`。ONNX Web 内嵌 factory 在 Node 合成 URL 下曾错误地尝试动态导入外部 `.mjs`；构建时对锁定的 1.23.2 bundle 调整判断顺序并用精确字符串校验后，`ocr-text` 对样本成功输出 `e-photo-1.jpg`。`ocr-table` 对该无表格样本正常报告空表格。Windows 同 EXE 运行及完整工具矩阵仍未验证。
- 2026-09-24：新增 `scripts/check-embedded-engine.mjs`，从隔离工作目录通过 stdio RPC 提交内存输入，检查图片信息 JSON、JPEG 文件头及非空 OCR 文本；Windows 嵌入构建在链接前执行该检查。macOS x64 上分别使用 Node 20.20.2、22.20.0 和 24.21.0 运行通过；此检查覆盖引擎 bundle 中三条路径，不证明 Windows 同 EXE 链接或其余工具。
- 2026-09-24：Windows `node-embed` 打包使用独立 Tauri 配置：前端构建直接调用 desktop build，`bundle.resources=[]` 不再将 `packages/engine/dist` 作为安装资源。Rust build script 对该配置设构建门槛，配置未生效时拒绝编译嵌入版，避免生成仍带 `engine/` 资源的安装包。SDK 构建已在独立分支的 Windows CI 并行启动 x64/x86；结果待验证。
- 2026-09-24：Windows x64/x86 build scripts 现调用 `scripts/build-windows-embedded.mjs`，要求架构匹配的 Node embed SDK，并通过 Tauri `--features node-embed` 把 CJS engine bundle 与 Node 静态库链接；portable ZIP 改为自行写 ZIP 结构且仅含单个 `PoTools.exe`，不复制 `engine/`、`node.exe` 或说明文件。ZIP 生成前检查 EXE 内的嵌入运行时标记，避免把旧 sidecar EXE 误打成单文件包；Rust build script 现在校验 SDK 目标、Node 版本、链接清单 SHA-256、每个静态库哈希及清单/元数据条目一致性。Node 脚本检查、Rust `cargo check --lib` 与一个带标记的 fixture ZIP 单条目检查通过；完整 Windows 链接和 EXE 运行未验证，因此这项只改变了构建路径，不证明可以成功发行。
- 2026-09-24：将 X.509 的 secp256k1 与 Brainpool 命名曲线纳入 Worker 证书解析，并校准曲线名称与 Node `KeyObject` 输出一致。用 OpenSSL 生成的 secp256k1、brainpoolP256r1 自签名证书均通过统一 RPC capability 路由并由内嵌 dispatcher 成功解析；之前这些输入会回退 Node sidecar。其他未识别曲线的回退边界仍在。
- 2026-09-24：扩大 Tauri host 的系统字体发现范围，扫描 Windows 系统/用户字体目录、macOS 系统/用户字体目录及 Linux 系统/用户字体树（递归深度最多 5、候选最多 2048），并由 Worker 在 128 MiB 总传输预算内检查最多 8 个字体文件的实际字形覆盖。显式字体仍优先；字体只以字节在内存传递，不写出应用运行时文件。Desktop typecheck 与 macOS host `cargo check` 通过；Windows/Linux 条件分支尚未交叉编译验证。
- 2026-09-24：统一 Worker 作业的输入文件读取失败不再启动 Node sidecar 重读同一路径。Host 直接通过同一 `job.updated` 队列发送 queued/running/failed 状态，并保留 `unreadable_file` 或 `bad_request` 错误类别；事件快照改用独立副本，避免连续状态被同一可变对象覆盖。尚需用真实缺失文件/权限拒绝场景核对 UI 提示与旧引擎一致。
- 2026-09-24：`page.thumbs` 的内嵌 Worker 路由新增图片缩略图，先用内存图片解码器处理 JPEG/PNG/WebP/TIFF，再尝试 WebView 图片解码，缩放不放大、白底展平，按原宽度/格式/质量规则生成 JPEG/PNG data URL；无法解码的输入仍回退 sidecar。Vite SSR dispatcher 冒烟确认图片预览和非第一页空结果由内嵌路由处理；尚未在 Windows WebView 与 Sharp 输出逐像素/元数据对照。
- 2026-09-24：Windows x64、x86 Tauri/NSIS cross-build 均由 macOS host 成功生成对应 EXE 和安装包；Windows 条件编译的 `print_file` 分支因尾随分号导致 `()` 类型错误，已修正。x64 安装包约 122 MB。此结果只证明交叉编译/打包链路可运行；构建日志确认当前仍准备并打包 Node runtime、`engine.mjs`、OCR 模型与资源，且未在 Windows 实机启动验证，单 EXE 目标未达成。
- 2026-09-24：Windows 启动入口在 Tauri 初始化前检查 WebView2；缺少时从微软下载 bootstrapper 并静默安装，失败时按系统 UI 语言显示错误。NSIS 安装包显式使用下载 bootstrapper 模式。Windows x64 安装包构建通过，生成的 NSIS 脚本将 `INSTALLWEBVIEW2MODE` 设为 `downloadBootstrapper` 并包含微软下载 URL；仍需在无 WebView2 的真实 Windows 环境验证下载、安装和首次启动全流程。
- 2026-09-24：添加 Linux x64/ARM64 本机打包入口，准备匹配架构的 Node、Sharp 与 ONNX Runtime 资源，输出 AppImage/DEB/RPM 到固定 `release/Linux/`。Debian 12 容器内完成 Linux x64 全量构建，三种发行包生成并收集到固定目录；DEB/RPM 元数据确认运行时依赖 WebKitGTK 4.1 与 GTK。此处验证了构建与包格式，未在带桌面的 Linux 主机启动应用，也未构建 ARM64 包。LoongArch 因缺少 Node/ONNX Runtime/Sharp 原生依赖未纳入目标。
- 2026-09-24：扩展 Linux 原生构建矩阵到 ARMv7、PowerPC64 LE、IBM Z（s390x），这些架构输出 DEB/RPM；x64、ARM64 仍输出 AppImage/DEB/RPM。为未提供 ONNX Runtime Node 原生包的 Linux 架构切到 ONNX Runtime WebAssembly，并将 Node.js 22.20.0、Sharp/libvips 运行时按架构准备。Engine/Desktop typecheck、desktop production build、打包脚本语法和 `git diff --check` 通过；本机是 macOS，新增架构未在原生 Linux 构建机验证，发行版 WebKitGTK/GTK 和 glibc 兼容性仍待实机验证。LoongArch、申威仍未配置。
- Windows 完整发行包和单架构发行命令统一收集到仓库根目录 `release/Windows/`；架构独立收集采用合并更新，避免依次打包时清空另一架构产物。Tauri target 目录仅作为构建缓存，最终交付仍从固定发行目录获取。
- 桌面内嵌执行统一使用 `{ method, params }` RPC envelope，由 Worker 调用 `packages/engine/src/browser.ts` 的 dispatcher；共享能力路由在 `packages/engine/src/browser-capabilities.ts`。目前 dispatcher 覆盖已迁移文本工具、标准 RSA 操作、常规 PDF 的 `file.probe`/`page.list`、页面和几何工具、PDF/图片转换、文档图片定位、元数据、文本/图片提取、部分修复与压缩、PDF→Word/PPTX/EPUB、OFD 导入兼容路径、水印/页码/页眉页脚、OCR 及票据拼版。未覆盖能力由同一 transport 回退 sidecar，回退是迁移兼容层，不能作为最终单 EXE 运行方式。
- 时间工具与金额转换共 10 个、开发工具 20 个、基础编码工具 5 个、密码生成/强度、UUID 与 TOTP 共 4 个 `tool.run` 实现已进入可由 Vite 打包的 browser-safe registry。正则匹配和替换在内嵌子 Worker 执行；150ms 执行上限触发时终止子 Worker，维持原有防止灾难性回溯阻塞的保护。Base64 文件解码也经标准 Web API 进入该 registry；文件转 Base64 通过同一 dispatcher 的 `job.submit` 接入内存文件适配器。IP 查询使用服务端明确开放的跨域接口由 Worker 请求；桌面 DNS 通过同一 `tool.run` 入口调用 Tauri Rust 的 Hickory Resolver，遵循 Windows/macOS/Linux 系统 DNS 配置；Web/本地 Node HTTP 运行模式继续使用原 Node Resolver。桌面本机 resolver 初始化或查询失败时直接返回错误，不再因此启动 sidecar。本机网络信息、Ping 和 TCP 检测从同一 RPC transport 调用 Tauri Rust host；TCP 在 Rust 内用 `TcpStream` 连接。哈希的 MD5 和 BLAKE2b512 使用内存实现，SHA-1/256/384/512 使用 Web Crypto；文件校验支持 MD5/SHA-1/256/512 及“全部算法”。AES 的 PBKDF2 与 scrypt 容器加解密（GCM/CBC/CTR）均由 Worker/Web Crypto 处理，并保留原 Node 容器格式。JWT 解码与 HS256/384/512、RS256、ES256 验签已进入 Worker；非加密公钥 SPKI PEM 和 JWK 由 Web Crypto 导入，私钥 PEM、PKCS#1 公钥及其他不兼容输入由路由回退 Node。
- 六个 PDF 页面工具（合并、拆分、整理、旋转、提取、删除）、几何工具（缩放、手动/自动贴合裁剪、页边距、每张多页）、元数据、PDF 压缩与修复及文件校验，均已接入同一 `job.submit` / `job.cancel` / `job.list` / `job.clear` 界面协议；Worker 负责内存处理和进度，Tauri host 负责读取用户选中的输入、暂存产物及写入选定输出目录。PDF.js 或 Canvas 不可用、PDF 加密/损坏或 `pdf-lib` 无法读取时回退兼容引擎。
- 图片压缩、缩放、裁剪、旋转、格式转换、图片信息查询、清除元数据、抠图输出、打印排版、蒙版水印修复和证件照排版进入同一内存 job dispatcher。打印排版在浏览器生成 A4/Letter 300 DPI JPEG；水印修复保持原蒙版阈值和局部邻域填补，并对超 2000 万像素的输入回退；证件照使用透明前景裁切、同一尺寸/边距/体积限制及 A4 拼版。UTIF Worker 解码 TIFF，现也用 jpeg-js 生成 JPEG 压缩 TIFF，供图片转换与压缩使用；输入格式为 TIFF 的其余已支持图片任务继续走内存解码。格式转换对其他输入格式也会尝试 WebView 解码，只有实际解码成功才走内存转换；损坏、超尺寸或 WebView 不支持的图片仍回退兼容引擎。图像解码和结果编码留在 Web Worker/Tauri 前端内存链路，不使用 Sharp 原生扩展。
- OCR 文本和表格识别已进入相同 `job.submit` dispatcher：PaddleOCR 使用 `onnxruntime-web/wasm`，ONNX 模型与 WASM 经 Vite 静态资源引用，随 `frontendDist` 嵌入 Tauri 应用；运行时只以 URL 读取内嵌资源，不释放 Node 模型目录或原生扩展。常见图片由 WebView 解码，经典 TIFF 由内嵌 UTIF 解码并应用 EXIF 方向，PDF 由 PDF.js 渲染；XLSX 由 JSZip 在 Worker 内存生成。当前限单图 2000 万像素和 PDF 单页 2000 万像素，其他 TIFF 变体/解码失败/超限 PDF 回退兼容引擎。
- 页面工具另存产物也会由 Tauri host 从应用缓存中的任务暂存文件复制到用户选定目录。缓存中的产物属于工具数据，不是随 EXE 分发的运行时依赖。
- Tauri 启动和健康检查改为本地 host；`engine.info`、`engine.ping`、`engine.setTempDir`、`tools.list`、`fs.browse`、`file.bytes`、`temp.stat`、`temp.clean`、本机网络信息/Ping/TCP、常规 PDF 的探测与页列表、文本产物写入、`shell.reveal` 和 `shell.print` 由 Tauri/Worker 直接处理。嵌入任务的暂存产物写入配置的 temp root；temp.clean 将嵌入与 sidecar 的 queued/running job id 作为保护项。未迁移 RPC 首次调用时才启动 sidecar。
- RPC 入口与执行路由不要求 UI 或工具页面逐个切换：页面继续调用相同 RPC；新增内嵌能力时更新共享路由策略及 dispatcher。当前按依赖拆分执行器，是为了逐批替换 Node 文件系统、原生模块及 OCR/图像运行时，不是要保留每工具一套入口。按 `TOOL_LIST` 布局对照 dispatcher 与本机 host，本轮盘点时所有纯文本工具、所有文件工具及票据整理的系统操作都有内嵌实现；剩下的迁移重点是兼容分支所覆盖的输入/选项边界，而不是新增独立入口。
- 2026-09-24：桌面 `dns-lookup`、`system-network`、`ping-check`、`tcp-check` 的 Tauri 原生调用失败时不再回退并启动 Node sidecar；错误通过现有 RPC 错误通道返回。这些桌面网络工具的正常和失败路径均不需要 Node 执行器。
- 其余 RPC 仍会启动旁置 `engine/node.exe` 兼容进程；尚未达到同 EXE 子进程和单 EXE 发行目标。
- 文本结果编码从 Node `Buffer` 改为跨 Node/Web API 的 `btoa` 实现，为更多纯计算工具共用 browser-safe runner 打下基础。

## 本地验证记录

- 2026-09-24：复核单 EXE child 原型时发现并修复 `process.argv` 中重复插入 `engine-embedded.cjs` 的确定性 bug；现由 C++ bootstrap 单独设置虚拟入口名，Rust 只传 `serve --stdio` 等引擎参数。Node SDK 的 Cargo 构建依赖现在递归跟踪 SDK headers、静态库及 metadata 变更。`pnpm typecheck`、`pnpm build`、engine embedded bundle 构建、embedded CJS 的 stdio ready + `engine.info` smoke、Rust host `cargo check --lib` 与 `git diff --check` 通过。smoke 明确报告 `imageCodec=false`（本机未加载 Sharp），只证明 bundle/协议启动，不证明同 EXE Node Embedder、Windows 静态链接或完整工具行为；`cargo fmt --check` 未运行成功，因为本机 stable toolchain 未安装 rustfmt。
- 2026-09-23：`pnpm --filter @potools/desktop build` 成功；OCR worker 产物约 1.7 MB，ONNX 两个模型（约 9.9/21.2 MB）、单线程 WASM（约 11.9 MB）和 PDF.js worker 都由 Vite 输出到 `frontendDist`，未包含 WebGPU 专用 WASM。浏览器 Worker 实测识别 PNG 与单页 PDF 内的 `PO TOOLS 123`，OCR 表格实测生成 XLSX 并由 SheetJS 重新打开，识别出 `ITEM QTY PRICE`、`APPLE 2 $3.00`、`ORANGE 5 $4.00`。同轮还验证了证件照输出尺寸/体积限制、Base64 二进制往返、MD5/HMAC-MD5 已知向量和文件校验“全部算法”（MD5/SHA-1/256/512）。临时目录 RPC 的 Tauri Rust host 改造经 `cargo check` 编译通过，桌面 TypeScript 经 `tsc --noEmit` 检查通过；`git diff --check` 通过。
- 2026-09-23：DNS 内嵌 Worker 实现经 engine typecheck 与桌面 Vite production build 检查；使用真实 DoH 请求核对 A/AAAA/MX/TXT/NS/SOA 返回格式，并以 `www.github.com` 验证 CNAME 记录解析。对无 CNAME 的域名会按现有错误契约返回 DNS 查询失败。
- 2026-09-24：桌面 DNS 查询改由 Hickory Resolver 读取操作系统配置的 DNS 服务器，经同一 `tool.run` 入口把结构化记录送入 Worker 格式化；修复原迁移路径绕开本机解析器而统一访问 Google Public DNS 的隐私及内网解析差异。Native resolver 按原 2.5 秒单次查询边界配置；Browser-only 版本保留 DoH。Rust host、Engine/Desktop typecheck 与记录格式 smoke check 通过；Windows resolver 注册表读取、内网域名和实际 DNS 记录查询仍待目标平台验证。
- 2026-09-24：本机网络信息、Ping、TCP 检测的 Tauri Rust 命令经 `cargo test`（本机 TCP listener 与主机名校验）通过，Engine/桌面 TypeScript 检查及桌面 production build 通过。Windows Ping 条件分支的独立 Rust 片段在 x64/x86 targets 均可编译；完整 `cargo check --target` 在 Tauri Windows resource 阶段因缺少 `llvm-rc` 而中止，尚不能记为 Windows 交叉编译通过。桌面命令调用仍需在 Windows 实机运行确认。系统网络详情依赖各 OS 自带的 `ipconfig`、`ifconfig` 或 `ip` 命令，Ping 输出保留系统命令原文。
- 2026-09-24：JWT browser-safe runner 经 Engine typecheck 与桌面 production build 检查；已用独立 HMAC 生成的令牌验证 HS256/384/512，并用 RSA/ECDSA 密钥验证 RS256/ES256 的 SPKI PEM 与 JWK 路径，检查中文与 emoji claim 的解码。私钥 PEM 的回退路由也已核对。Tauri Windows 实机仍未验证。
- 2026-09-24：正则工具改用内嵌子 Worker 执行并可在超时后终止；桌面生产构建已生成独立的 `regex-runner.worker` 资源，证明嵌套 Worker 被 Vite 正确打包。Engine typecheck 和桌面 TypeScript/build 检查通过；尚未在 Tauri WebView 中实机验证超时和各种浏览器正则边界。
- 2026-09-24：PDF 元数据读取、写入和清除接入统一内存 job dispatcher，沿用现有字段默认值、XMP 清理、日期清理及输出命名规则；对 `sample-a.pdf` 的三种模式逐个与 Node 工具比对，结果 JSON/PDF 产物数量、名称和 SHA-256 均一致。Engine typecheck、桌面 production build 和 `git diff --check` 通过。Windows 绿色包仍复制 Node engine sidecar，单 EXE 目标仍未达成。
- 2026-09-24：BLAKE2b512 增加纯 TypeScript 内存实现，桌面路由不再因该算法回退 Node；与 Node `blake2b512` 输出逐字节比对 0、3、127、128、129、1024、65537 字节输入一致。Node 引擎继续使用 Node 原生实现。桌面 Worker 运行结果尚待 Tauri WebView 验证。
- 2026-09-24：普通 PDF 文本提取经 PDF.js Worker 内存实现，支持原有选页、逐页/合并文件、页码标记、密码参数和文字层为空时回退。用 `sample-a.pdf`、`sample-b.pdf`、`sample-invoice.pdf` 按页与 MuPDF 的文本结果精确比对（含换行）一致；Engine typecheck 通过，Tauri WebView 行为尚未实机确认。
- 2026-09-24：删除空白页增加 PDF.js/Canvas 内存路径，输出继续由 pdf-lib 写入。使用矢量测试页对比 MuPDF+Sharp 的 36 DPI ink ratio：空白页均为 0，含内容页差值为 0.000399（浏览器路径使用 ±0.005 边界回退保护）。Engine typecheck 与桌面生产构建通过；Windows WebView 的 Canvas 像素差异和带密码 PDF 尚待实机确认。
- 2026-09-24：PDF 图片提取接入同一 `job.submit` dispatcher。以 `sample-photos.pdf` 第 1 页执行内存 job，返回 `sample-photos-img01.jpg`，3166257 字节且 JPEG SOI 签名正确；Engine typecheck、桌面 TypeScript/Vite production build 与 `git diff --check` 通过。原始流提取不需要 Canvas；JPEG/PNG/WebP 转码只有在 WebView 提供 `createImageBitmap` 和 `OffscreenCanvas` 时路由到内嵌执行，否则回退原执行器。PDF 的 JBIG2/CCITT/JPX 原始流可导出；Canvas 不支持转码时与原工具一致保留原格式。Tauri WebView 实机转码尚待验证。
- 2026-09-24：PDF 修复在关闭“重压缩”时复用 `pdf-lib` 内存加载/写回路径，正常可读文件接入同一 dispatcher。样例 `sample-a.pdf` 的 3 页经内存适配器输出后，页数不变、标题/作者元数据清空，并与原 Node 工具的输出逐字节一致（23,566 字节）；Engine typecheck 和桌面 TypeScript/Vite production build 通过。启用重压缩（默认）或 `pdf-lib` 无法直接读取的损坏文件继续由兼容引擎使用 MuPDF；Tauri WebView 实机运行尚待验证。
- 2026-09-24：PDF 转图片与图片转 PDF 两个转换工具接入同一内存 dispatcher。PDF 渲染用 PDF.js、单页 Canvas 尺寸沿用 MuPDF 的 24 MP/6000 px 上限，图片方向、透明度、输出格式、页范围及既有布局参数保留；图片转 PDF 仅路由浏览器可解码且不超过 20 MP 的 JPEG/PNG/WebP，其他输入回退兼容引擎。Engine typecheck 与桌面 production build 通过，构建中包含 2.35 MB PDF.js worker 资产；当前环境没有可用 Canvas/WebView，转换像素结果和 Tauri worker URL 实机加载尚未验证。
- 2026-09-24：PDF 自动贴合裁剪和 PDF 压缩进入同一内存任务组。裁剪沿用 72 DPI、246 灰度阈值、单像素留白及页面旋转回映射；PDF 压缩沿用原 DCTDecode/DeviceRGB/DeviceGray/8-bit/无软蒙版筛选、尺寸上限、质量范围和体积不降则跳过规则。`sample-a.pdf` 上手动裁剪与原实现逐字节一致（23,590 字节）；关闭图像重采样的压缩也逐字节一致（23,580 字节）。自动裁边随后改用 MuPDF WASM；与原 MuPDF 实现的像素边界差异已在票据拼版默认裁边路径逐页校验为 0。嵌入 JPEG 重采样尚未在 WebView 验证，非 DCT 或特殊色彩图像按既有规则跳过。
- 2026-09-24：PDF 水印、页码、页眉页脚作为一组接入统一 dispatcher。使用 Helvetica 可编码的三类样例都与原 Node 输出逐字节一致（24,319/24,488/24,649 字节）；含中文等需要系统字体的内容会返回兼容引擎处理，保持原字体发现和嵌入能力。Engine typecheck 和三项输出比对通过；Tauri WebView 尚未实机验证。
- 2026-09-24：PDF 到 Markdown、HTML、CSV、RTF 四种文字导出接入同一 PDF.js Worker 文档模型和 `job.submit` dispatcher。段落间距与旧 MuPDF 文本块分段规则校准后，`sample-a.pdf` 四种产物均与原 Node 工具逐字节一致；含图片且要求保留图片的 Markdown 会回退兼容引擎，避免丢失内容。Engine typecheck、桌面 production build 与四种产物逐字节比对通过；复杂双栏/表格版式和 Tauri WebView 尚待实机复核。
- 2026-09-24：`invoice.archive` / `invoice.undo` 在既有 RPC 入口下改由 Tauri Rust host 执行；校验源文件路径与 SHA-256、拒绝目标路径穿越和符号链接目录、按既有冲突规则生成副本，并仅在内容摘要未变化时撤销。Rust 单测覆盖归档后撤销、冲突跳过和路径保护，`cargo check` 与 `cargo test` 通过。
- 2026-09-24：`invoice.scan` 的 Rust 安全目录枚举与逐文件读取、Worker SHA-256 和 MuPDF WASM 文本提取接入同一 RPC 路径。浏览器真实 Worker 对 `sample-a.pdf`、`sample-b.pdf`、`sample-invoice.pdf`、`sample-photos.pdf`、`sample-rotated.pdf` 的摘要、页数、提取文本、识别状态及字段均与原 Node 扫描结果一致；无效 PDF 的错误文本也一致。Vite 将 MuPDF 模块及约 10.4 MB WASM 作为前端构建资产输出，按需加载；Engine/desktop typecheck、desktop production build、7 项 Rust 单测及 `cargo check` 通过。尚未在 Windows Tauri WebView/EXE 实测资源加载。
- 2026-09-24：`invoice-merge` 通过统一 `job.submit` dispatcher 进入 Worker，沿用共享工具实现，宿主注入 MuPDF WASM PDF 加载回退和自动裁边服务。浏览器 Worker 与原 Node 工具对 `sample-invoice.pdf` + `sample-a.pdf`、自动裁边开启/关闭两组结果逐页比对，页数、页面框、文字层、工具统计、警告及 MuPDF 72 DPI 渲染像素全部一致；自动裁边默认开启路径不再启动 sidecar。MuPDF WASM 自动裁边服务也替代 PDF.js Canvas 路径用于裁剪工具，以保持和原 MuPDF 的边界判定一致。Engine/desktop typecheck 与 production build 通过；Windows Tauri WebView/EXE 仍待实测。
- 2026-09-24：空白页检测改用 MuPDF WASM 在 Worker 中按 36 DPI 渲染，去掉 OffscreenCanvas 与阈值边界回退；共享 RPC 路由不变。`sample-a.pdf` 在 0/1/10/50/100 五档容差下，Worker 与 Node 的空白页报告、警告和统计一致。Engine typecheck 和 desktop production build 通过；不同 PDF 灰度边界、加密 PDF 及 Windows WebView 结果仍需逐项对照验证。
- 2026-09-24：RSA 与 X.509 在同一 `tool.run` Worker dispatcher 中完成支持范围扩展。RSA 的加密私钥、PKCS#1 v1.5 加解密已通过 Node/Worker 交叉验证。`x509` 用 node-forge 解析 RSA 证书，以 Web Crypto 计算指纹；含 CA、Key Usage、EKU、SAN、SKI/AKI、AIA/OCSP 的证书在中文和英文下与旧 Node 工具比对，summary/full-json 文本及 extra 一致，JSON 除动态 `remainingDays` 外各字段一致。另用 OpenSSL ECDSA 证书确认能力路由不将非 RSA 密钥送入内嵌执行器。修复 Node 工具对字符串型 `infoAccess` 调用 `.join` 的错误。Engine typecheck、desktop typecheck/Vite production build 通过；尚未覆盖真实证书集、更多 RSA 扩展组合或 Windows WebView。node-forge BSD/GPL 双许可文本随应用附带。
- 2026-09-24：`pdf-to-excel` 进入共享 `job.submit` Worker dispatcher；复用 PDF.js 文本位置读取和共享 JSZip XLSX 写入，不启动 ExcelJS/Node streams。对 `sample-a.pdf`、`sample-invoice.pdf`、`sample-rotated.pdf` 的合并工作表/逐页工作表及 18pt 列间距共 6 组结果，与原 ExcelJS 工具逐表比对，工作表名称、每格文本、空白工作簿行为、输出文件名和 summary.extra 均一致。OCR XLSX 也切换到同一共享写入器。Engine typecheck 和 desktop production build 通过；复杂旋转/字体布局、加密损坏 PDF 在 Windows WebView 中仍需复核。
- 2026-09-24：`pdf-to-epub` 的纯文本 PDF 路径接入共享 `job.submit` Worker dispatcher，沿用统一文本布局读取、章节策略、文件命名和 EPUB 写入器；检测到图像内容且用户要求保留图片时由统一 dispatcher 回退兼容引擎，避免静默漏图。对 `sample-a.pdf`、`sample-invoice.pdf`、`sample-rotated.pdf` 的章节按标题/按页共 6 组，比对每个 XHTML 章节内容、产物名称和 summary.extra 均无差异。Engine typecheck、desktop typecheck/Vite production build 通过；图片内容仍走兼容路径。
- 2026-09-24：PDF 图片区域读取修正了内容流 `/XObject` 名称分词及 `cm` 矩阵拼接顺序，并将 Word/EPUB 图片裁切收敛为共享 Worker helper。`pdf-to-epub` 的 includeImages 模式现用原版面模型和 MuPDF WASM 生成内嵌 EPUB 图片。生产 Vite Worker 处理 `sample-photos.pdf` 成功，EPUB ZIP 中 3 张 PNG 均存在且被 XHTML 恰好引用 3 次；Engine typecheck、desktop production build、`git diff --check` 通过。完整引擎工具 harness 为 302/311，剩余失败位于 timestamp/date-diff、hash/password-gen 和 OCR table 检查；本轮图像导出相关 coverage 通过。Windows WebView 与单 EXE 仍未验证。
- 2026-09-24：`ofd-to-pdf` 接入共享 `job.submit` Worker dispatcher。OFD 解包/XML 解析复用 JSZip 与 fast-xml-parser，PDF 用 pdf-lib 写入；标准字集和包内可读字体在 Worker 内处理，需访问系统字体的内容回退兼容引擎。仓库样例 `sample-office.ofd` 含无内嵌字体的中文，确认按预期回退；另以生成的 ASCII OFD 确认内嵌路径输出单页 PDF，页面尺寸、输出名称正确。Engine typecheck、desktop typecheck/Vite production build 通过；尚未完成内嵌字体、多媒体/旋转/复杂 OFD 的输出内容对照，暂不宣称全面一致。
- 2026-09-24：`pdf-to-ppt` 接入共享 `job.submit` Worker dispatcher；页面由 MuPDF WASM 渲染，沿用相同 PDF 结构化版面模型和可复用 PPTX writer，不再依赖 Sharp 或 Node Buffer。对 `sample-a.pdf`、`sample-rotated.pdf`、含嵌入图片的 `sample-photos.pdf` 的文字层开关共 6 组，逐张核对 slide XML 和 PNG 解码像素均一致，输出名称及摘要一致。为避免浏览器执行器静态依赖 Node zlib，PDF 图片定位改为 `DecompressionStream`，Node/Web Streams 两端使用相同解析逻辑。Engine typecheck、desktop typecheck/Vite production build 通过；复杂 PDF 图像流过滤器和真实 Tauri WebView 仍待覆盖验证。
- 2026-09-24：`pdf-to-word` 接入同一 `job.submit` dispatcher，复用文档布局及 DOCX 内容构造，浏览器用 `Packer.toBlob` 写入内存；嵌入 MuPDF 页面图像裁切，并调用已有 ONNX Web OCR 处理无文字页，扫描页识别为空时仍保留整页图像。与旧 DOCX 对照 `sample-a.pdf` 两种分页设置及包含页面图像的 `sample-photos.pdf` 共 3 组，document.xml、图片解码像素、输出名和 summary.extra 均一致。当前 Node harness 无 OffscreenCanvas 的 `sample-rotated.pdf` OCR 分支按预期回退，尚未在真实 Windows WebView 验证 ONNX OCR 和画布裁切；Engine typecheck、Node engine bundle 和 desktop production build 通过。
- 2026-09-24：`markdown-to-pdf` 共用 Typesetter 排版逻辑接入同一 `job.submit` dispatcher；Tauri host 预读用户配置字体和 Markdown 中独立行图片引用的相对文件为字节，Worker 使用 pdf-lib/fontkit 内存排版与写出。未提供配置字体或字体缺字时按统一路由回退兼容引擎；复杂图片语法仍沿用旧引擎。Engine typecheck、Node engine bundle、desktop typecheck/Vite production build 与 `git diff --check` 通过；Markdown 内容/图片结果对照和 Windows WebView 字体与路径行为尚未实测。
- 2026-09-24：AES 的 PBKDF2 与 scrypt 均由 `tool.run` 的既有统一 Worker dispatcher 执行。scrypt 使用 RFC 7914 的 Salsa20/8、BlockMix、ROMix 和 Web Crypto PBKDF2；Salsa20/8、BlockMix、ROMix 的 RFC 测试向量通过，容器版本、KDF/算法编号及各字段布局沿用原格式。以 Node 加密容器→Worker 解密、Worker 加密容器→Node 解密交叉核对 GCM、AES-256-CBC、AES-128-CBC、AES-CTR 四种算法均通过；Engine/desktop typecheck、desktop production build 与 `git diff --check` 通过。Windows WebView scrypt 的耗时/内存尚未实机复核。
- 2026-09-24：`shell.print` 保持 RPC 契约，由 Tauri Rust host 验证目标文件并调用 Windows PowerShell 系统 Print 动词；macOS/Linux 使用 `lp` 并保留队列回执，移除该操作对 Node RPC 的依赖。Rust host `cargo check` 通过；Windows 命令分支独立以 x64/x86 MSVC target 编译通过。完整 Tauri Windows `cargo check` 仍被构建脚本缺少 `llvm-rc` 阻断，Windows 打印关联与无默认打印机错误尚未在实机复核。
- 2026-09-24：`pdf-to-ofd` 的图像模式及显式配置字体的文字模式接入同一个 `job.submit` Worker dispatcher。Tauri host 预读所选字体为内存字节；系统自动发现字体仍走兼容引擎。与旧工具对照 `sample-a.pdf`：图像模式 OFD ZIP 条目/页数一致，3 页 PNG 解码像素完全一致；文字模式（STHeiti 字体）除带时间戳的 `OFD.xml` 外，文件条目字节完全一致。Engine/desktop typecheck 和 `git diff --check` 通过；实际 Worker/WebView 与 Windows 单 EXE 运行仍未实测。
- 2026-09-24：Markdown/HTML PDF 导出统一复用文档模型、MuPDF WASM 和 Worker 图片区域适配器；Markdown 按 includeImages 裁切并输出图片文件，HTML 按 embedImages 设置内嵌或输出图片文件，移除对“PDF 有图片就回退”的分支。RTF/CSV 继续使用同一文本读取适配。Engine typecheck、desktop production build 与 `git diff --check` 通过；本次未运行工具回归套件，图片内容与旧 sidecar 逐项一致性仍待验证。
- 2026-09-24：Worker 与 Node 兼容路径共用 `normalizePdfBytes`；统一的内存 PDF 加载适配器接收作业 globals，并在 PDF-lib 遇到加密文档时用 MuPDF WASM 按用户密码认证后解密重建内存 PDF；无密码和错误密码仍回到原有兼容处理。Engine/desktop typecheck、engine bundle、desktop production build 与 `git diff --check` 通过；本次未创建加密样例做行为对照。
- 2026-09-24：`extract-text` 遇到无文字层 PDF 时直接返回既有 `empty_selection` 结果，不再为了返回同一错误而启动 Node 兼容引擎；密码/解析类异常仍保留原回退路径。Engine/desktop typecheck 与 `git diff --check` 通过；本次未运行端到端工具测试。
- 2026-09-24：宿主字体资源适配器开始按依赖能力复用：系统字体候选、二进制内存传输、TTC 字体字形覆盖检查与 PDF 字体嵌入共用一套实现，接入 Markdown 未配置字体和 PDF 转 OFD 自动字体模式；水印、页码、页眉页脚也切到同一字形匹配器。遇到无法子集嵌入的字体会继续尝试下一候选。PDF 转 OFD 文本模式不再要求显式字体路径才尝试 Worker。Engine typecheck、desktop production build（含 TypeScript 检查）、真实 macOS TTC 中文字体嵌入并重新打开 PDF 的 smoke check，以及 `git diff --check` 通过；新增的自动字体 Worker 行为及 Windows WebView 仍未实测。
- 2026-09-24：新增直接依赖 UTIF.js 3.1.0 并将经典 TIFF 解码接入内嵌 Worker；按 EXIF orientation 生成方向校正后的 bitmap，格式/压缩设置只有明确转 JPEG/PNG/WebP 等已验证输出时才进入内嵌路线，避免 TIFF 原格式及编码行为改变。生产 Worker 将 2×3 orientation 6 TIFF 转 PNG 后得到 3×2 图像，六个 RGBA 像素与预期逐点一致；OCR Worker 对 `sample-scan-2.png` 与其 TIFF 转码版本返回完全相同的文字。Engine/desktop typecheck、桌面 production build 与 `git diff --check` 通过。Windows WebView/单 EXE 运行仍未实测。
- 2026-09-24：`image-convert` 与 `image-compress` 的 TIFF 输出也接入内嵌 Worker。使用 jpeg-js 生成 JPEG strip，并用 UTIF 写入 Compression=7 TIFF IFD；运行时冒烟确认 Sharp 将产物识别为正确尺寸/通道的 TIFF，且 UTIF 能重新解码图像。RGBA 经黑底合成后与现有 Sharp TIFF 行为一致。Worker/Windows WebView 的真实 OffscreenCanvas 画布仍需实机确认。
- 2026-09-24：PDF 探测和页列表在内嵌解析时遇到 `encrypted_document` 直接返回现有 RPC 错误，不再将“文档需密码”误作未处理并启动兼容 sidecar；其他无法由 pdf-lib/MuPDF WASM 解析的情况仍保留兼容路径。Engine、desktop typecheck 与 `git diff --check` 通过，Tauri WebView 的错误提示流程尚未实机验证。
- 2026-09-24：图片格式转换会对已识别格式之外的输入尝试 `createImageBitmap`，只有 WebView 解码成功且尺寸符合现有内存上限时才进入 Worker；目标格式仍按工具选项确定。Engine/desktop typecheck 与生产构建通过；WebView 实际支持的来源格式依操作系统运行时而异，解码失败时保留兼容引擎。
- 2026-09-24：PDF 修复默认重压缩路径接入内嵌 Worker，使用随前端构建的 MuPDF WASM 在内存中重建 PDF 后复用原修复器。生产 Worker 处理 `sample-a.pdf` 和 `sample-rotated.pdf` 均成功；与 Node 旧路径产物相比，三页 `sample-a.pdf` 与旋转页样例的每页 MuPDF WASM 渲染像素完全一致（旋转样例字节哈希也相同；`sample-a.pdf` 序列化字节不同）；错误 `startxref` 样例仍恢复为 3 页，截断样例仍以失败状态拒绝。Engine/desktop typecheck 及桌面 production build 通过；Windows WebView/单 EXE 仍未实测。
- Worker 迁移记录只证明相应切片在浏览器运行；默认 Tauri 发行配置仍复制 `packages/engine/dist` 和 `node.exe`，Rust host 仍启动旁置 Node sidecar。`node-embed` 只验证到目标级编译，真实 Node 链接、同 EXE 子进程握手、模块内嵌和无释放运行均未验证，因此不能称为单 EXE 完成。

此切片只证明迁移机制，桌面启动仍依赖 Node sidecar；它不代表单 EXE 目标已完成。

## 验收边界

- 发行目录不得出现旁置 `engine/`、`node.exe`、`node_modules`、OCR 模型或运行时 DLL 等应用附属文件；引擎子进程必须由 `PoTools.exe` 自身启动。
- 不允许通过临时目录、用户数据目录或程序旁目录解压应用运行时。
- 工具为输入/输出而创建的用户文档及工作文件仍按现有产品功能处理；这与释放程序依赖文件是不同边界。
- 只有在 Node runtime 与引擎资产已随 `PoTools.exe` 编入、x64/x86 均由该 EXE 成功启动引擎子进程、无运行时释放且工具行为实机验证通过后，才可称为单 EXE 完成。

## 参考

- [Node.js Single Executable Applications](https://nodejs.org/download/release/latest-jod/docs/api/single-executable-applications.html)：SEA 注入脚本仅能直接加载内置模块；原生扩展需先写文件，再调用 `process.dlopen()`。
- [Tauri Embedding Additional Files](https://v2.tauri.app/develop/resources/)：Tauri `bundle.resources` 将额外资源复制到应用资源目录。
- [Tauri Build Configuration](https://v2.tauri.app/reference/config/)：配置路径形式的 `frontendDist` 会递归嵌入应用二进制。
- [Tauri Process Model](https://v2.tauri.app/concept/process-model/)：Tauri 使用系统 WebView 进程渲染 UI，Windows 使用 WebView2。
- [ONNX Runtime Web](https://onnxruntime.ai/docs/get-started/with-javascript/web.html)：Node.js 的 WASM 执行提供程序仅支持单线程；改为 WASM 本身并不能消除 Node sidecar 和资源加载边界。
