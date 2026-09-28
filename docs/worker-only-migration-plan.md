# Worker-only 迁移执行计划（移除 Node 运行时）

对应 2026-09-28 架构分析的方案 A：全部工具在 WebView Worker / Rust host 内执行，发行包不再携带 Node 运行时（node.exe/node、engine/node_modules、engine/ocr-models、engine.mjs），同时放弃 node-embed 单 EXE 路线（方案 A 使其失去意义）。

## 终态定义

- 发行目录只有：应用二进制（含前端资产）+ WebView2 运行时由系统提供。无 `engine/`、无 `node.exe`、无 `node_modules`、无旁置 OCR 模型目录。
- 执行路径唯一：UI → 统一 `{method, params}` RPC → Worker dispatcher（`packages/engine/src/browser.ts`）+ Rust host 特权命令。`handled:false` 不再存在——能力不足时返回与旧 sidecar 语义对齐的显式错误。
- 仓库内不再有 Node 引擎实现（rpc.ts/jobs.ts/serve/* 及 `tools/` 的 Node 专属双实现删除），工具只有一套 Worker 实现 + Rust host 命令。
- 预期体积：前端 84MB（去重后 ~80MB）直接成为全部载荷，安装包压缩后约 50MB 级（对比当前 NSIS 122MB）。

## 基线证据（2026-09-28 侦察结果）

- 工具覆盖：`TOOL_LIST` 共 98 个 ID；`embedded-registry.ts` 注册 49 文本 + 49 文件 = 97 个。唯一缺口 `invoice-organize` 不是 ToolImpl：UI 直接驱动 `invoice.scan`（Worker 已有单文件分析，MuPDF WASM）+ `invoice.archive`/`invoice.undo`（Rust host 原生，`apps/desktop/src/lib/transport.ts:558-573`）。
- 回退是三层漏斗，任一命中即由 `transport.ts:683`/`:781-785`/`:402` 启动 sidecar 重跑：
  1. `browser-capabilities.ts` 静态能力预判（环境 API 缺失、算法白名单、参数组合）；
  2. `browser.ts` dispatcher 输入内容预检（魔数/像素预算/PDF 可解析性），返回 `handled:false`；
  3. 工具执行中抛 `InMemoryFallback`（`memory-job.ts:136` 统一转 `handled:false`）。
  唯一不回退的例外：`encrypted_document`（transport.ts:341 直接透传 UI）。
- 依赖分布：Node 专属且可删——sharp、@img/sharp-wasm32、onnxruntime-node、exceljs（Worker 用 JSZip 写 XLSX）、fontkit（源码零引用）。必须保留——paddleocr（`ocr-browser.ts:1` 也依赖其推理编排）、mupdf、onnxruntime-web、pdf-lib、pdfjs-dist、docx、pptxgenjs（两端共用同一 writer）、yaml、bcryptjs、fast-xml-parser、node-forge、jszip、jpeg-js、utif。
- node-embed 触点：`Cargo.toml` feature、`build.rs:13-336`、`native/node_embed.cpp`、`lib.rs:151-165/494-546`、`main.rs:5-9`、`tauri.windows-embedded.conf.json`、`scripts/build-windows-embedded.mjs`、`scripts/package-windows-portable.mjs`、`scripts/check-embedded-engine.mjs`、`scripts/build-node-embed-sdk.ps1` + `node-embed-manifest-exporter.cs`、`.github/workflows/node-embed-sdk.yml`、`packages/engine` 的 `build:embedded` + `scripts/build-embedded.mjs` + `embedded-mupdf-entry.mjs`。

## 已拍板的决策（2026-09-28）

1. **macOS 最低系统版本：提升到 13.0**（OffscreenCanvas 2D 需 WKWebView ≥ Safari 16.4）。`tauri.conf.json` 的 `minimumSystemVersion` 在阶段 4 能力闸门落地时一并修改。
2. **原回退输入的最终行为：统一显式错误**。错误码与文案对齐旧引擎；SHA-3、超限 OCR 下采样等个别能力留待后续版本按真实需求再补。
3. **测试基准：golden 基线先行**。阶段 0 先用当前 Node 引擎固化全部产物哈希/JSON 快照入库，阶段 9 才删 Node 实现。
4. **mediapipe：保留常驻**。维持离线完整功能与本地优先定位；不做按需下载，不移除证件照自动抠图。

## 分阶段计划

每阶段以一个可验证的 gate 结束；阶段 0-6 期间 sidecar 保持可用（回滚保障），阶段 7 起才拆除。

## 进度记录

- **2026-09-28 阶段 0（部分完成）**：
  - ✅ golden 基线三件套落地：`run-tools.ts` 采集（`--golden-out`，条目含 inputs/options/files 供回放）、`merge-golden.mjs` 双进程比对（稳定条目标 `stable:true`，不稳定条目剥离 digest/text/summary 只留结构契约）、`pnpm test:golden` 产出 `packages/engine/testdata/golden-node.json`（227 条目，两轮采集均 311/312 绿）。
  - ✅ 确定性规范化 `src/testing/canonical-artifact.ts`（Node/浏览器共用，纯 Web API）：PDF 骨架+FlateDecode 解压流内日期归一（含 `endstream` 子串假匹配、对象级 `/Length` 窗口两处解析修复）、ZIP 按条目名+内容语义哈希。不稳定条目 155→33；剩余 20 条为随机/时间族（timestamp/date-format/password-gen/uuid-gen/jwt/aes/rsa，浏览器 harness 需改用固定夹具），13 条为间接 `/Length` 的 PDF/ZIP（留结构契约，字节级一致性由后续 MuPDF 像素比对覆盖）。
  - ✅ 前端去重：pdf.worker 统一 legacy（6 处，2→1 份，-2.2MB）；transport 移除主线程 `canRunEmbeddedRpc` 预判改为 worker-first（dispatcher 为权威，`handled:false` 才回退 sidecar），主应用图不再拖入全部 Worker 实现，pptxgen chunk 2→1；`apps/desktop/dist` 84MB→80MB；全仓 typecheck 绿。
  - ⬜ 待办：Playwright 浏览器 harness（Chromium 已缓存，加载真实 `embedded-engine.worker` 跑 golden 回放比对；随机族工具用固定夹具单独断言）。

### 阶段 0：基线与测试网（其他一切的前提）

- 建 golden 基线：对 `samples/` 全部夹具用当前 Node 引擎跑 `pnpm test:tools`（302/311 通过集），把每个检查的产物 SHA-256 / 结构化 JSON 快照固化到仓库（如 `packages/engine/testdata/golden/`）。
- 建浏览器执行 harness：用 Playwright（Chromium headless，配 `--enable-features` 对齐 WebView2 能力）加载 Vite 构建的 `embedded-engine.worker`，跑同一套断言（复用 `run-tools.ts` 的用例定义，换传输层为 postMessage）。这一 harness 后续替代 `pnpm test:tools` 成为回归主入口。
- 前端去重快赢：消除 `pdf.worker` 双份产物（2.1+2.2MB，排查 pdfjs-dist 两种 worker 引入路径）、pptxgenjs 双 chunk；`pnpm typecheck` + 构建产物 diff 验证。
- Rust host 侧无改动。
- **Gate**：golden 基线覆盖现有全部通过用例；浏览器 harness 在 Chromium 上对纯计算工具（时间/编码/加密/开发者）全绿。

### 阶段 1：错误语义对齐（sidecar 本来也会失败的边界 → Worker 显式报同款错误）

逐条关闭 `browser-capabilities.ts` 中"回退后 sidecar 同样报错"的分支，错误码与文案以 golden 基线为准：

- `aes` 非本引擎容器格式的密文（browser-capabilities.ts:170-184）→ `bad_ciphertext_format`。
- `jwt` RS/ES 算法配裸字符串 secret（:156）→ 与 Node 相同的密钥格式错误。
- `rsa` 加密私钥无 passphrase、JSON 密钥非 RSA、未知 mode（:111-138）→ 对齐 node:crypto 错误语义；若工具已有 passphrase 参数则补支持。
- `x509` 未识别 EC 曲线/非白名单 OID（crypto-x509-browser.ts:59-95）→ 新增 `unsupported_curve` 显式错误（保留能力表持续扩充的口子）。
- `hmac` 补 SHA-384（Web Crypto 本就支持，白名单遗漏，browser-capabilities.ts:96-100）。
- `file-checksum`/`hash` 白名单外算法（sha3/sm3）→ 按决策 2：显式 `unsupported_algorithm`，或列为阶段 4 可选实现项。
- **Gate**：受影响工具的 golden 错误快照在浏览器 harness 全部一致。

### 阶段 2：PDF 加密/损坏统一 MuPDF WASM 兜底

- `memory-job.ts:85-93`：加密且无密码 → 统一 `encrypted_document`（UI 已有该错误通路）；密码错误 → `wrong_password`；不再回退。
- pdf.js/pdf-lib 解析失败的路径（`pdf.ts:31-54`、extract-text-browser、pdf-text-export-browser、convert-browser 等）统一接入已存在的 `normalizePdfBytes` + MuPDF WASM 认证/重建；MuPDF 也失败 → `unreadable_document`。
- `remove-blank` 的"pdf-lib 与 MuPDF 页数不一致"防御分支（remove-blank-browser.ts:38）改为显式错误。
- **Gate**：加密/损坏/截断 PDF 样例在浏览器 harness 的行为与 golden 一致（含错误文本）。

### 阶段 3：字体链路统一

- host 字体注入从"文本含非 ASCII 才注入"（transport.ts:771-773、882-888）改为相关工具统一注入（水印/页码/页眉脚/markdown-to-pdf/ofd 双向/pdf-to-word 扫描页）。
- 字形覆盖失败（markup-browser.ts:110/186/225/230、markdown-to-pdf-browser.ts:82-96、ofd-to-pdf-browser.ts:67、pdf-to-ofd-browser.ts:34）→ `font_missing_glyphs` 显式错误，附候选字体列表。
- **Gate**：CJK 水印、无字体 Markdown、缺内嵌字体 OFD 三类样例行为对齐 golden。

### 阶段 4：图像/OCR 输入边界

- 输入格式判定从"魔数白名单"改为"白名单 + `createImageBitmap` 尝试"（image-convert 已是此策略，推广到全部 image-*，image-browser.ts:37-65）；HEIC 接入已在前端产物中的 heic2any。
- TIFF：UTIF 尽力解码，失败/超限 → 显式错误（不再回退 sharp）。
- OCR >20MP（ocr-browser.ts:218-225）：显式错误 + 文档说明；可选后续版本做渲染期下采样。
- `compress` 的 >80MP 解码预算、`image-watermark-clean`/`image-id-photo` 20MP 预算保持，超限改显式错误。
- 环境能力闸门前置：应用启动时探测 OffscreenCanvas/createImageBitmap/crypto.subtle/Worker，缺失时全局一次性提示（取代逐工具回退）；关联决策 1 的 macOS 版本要求。
- **Gate**：GIF/BMP/AVIF/HEIC/TIFF/超限像素样例矩阵在 harness 通过；三平台（WebView2/WKWebView/WebKitGTK）能力探测报告落档。

### 阶段 5：发票与目录收尾

- `invoice.scan` 单文件 Worker 分析失败（transport.ts:398-402）→ 单文件错误汇总进扫描报告，不再整批回退。
- `fs.browse` 原生 invoke 失败（transport.ts:521-530）→ 直接返回错误。
- `job.list`/`job.clear`/`job.cancel`/`file.write` 的 sidecar 分支（transport.ts:646/664-682）确认全部内嵌化后的行为（内嵌 job 表已是权威，sidecar 合并逻辑删）。
- **Gate**：发票目录含损坏文件/无权限子目录的样例通过。

### 阶段 6：无 sidecar 灰度模式

- transport 增加 `POTOOLS_NO_SIDECAR` 开关：开启时所有 `handled:false` 转显式错误（上述阶段未覆盖的漏网边界在此暴露）。
- `engine.info` 由 Worker 真实自检填充（rasterizer/imageCodec/cjkFont 现为占位值，transport.ts:293-313）。
- 开发模式 `pnpm dev` 改为纯 Vite+Worker；`HttpTransport`（dev:web 的 Node HTTP 引擎客户端，transport.ts:115-244）标记弃用。
- 用灰度模式跑完整 golden 回归，把剩余命中 `handled:false` 的用例归零或显式豁免。
- **Gate**：灰度模式下全量 golden 回归通过；此为切换前的最后安全网。

### 阶段 7：切换默认发行（删 Node 打包链）

- `apps/desktop/src-tauri/tauri.conf.json`：`beforeBuildCommand` 去掉 `prepare-engine-runtime.mjs`、engine build、`prepare-ocr-runtime.mjs`；`bundle.resources` 五条（L49-55）全删。
- 删除 `apps/desktop/scripts/prepare-engine-runtime.mjs`、`prepare-ocr-runtime.mjs`。
- `lib.rs`：删 `find_node`/`dev_engine_dir`/sidecar 版 `engine_launch`/`start_engine`/`pump_*`/`engine_start|write|stop` 命令（L25-461）及 `Engine` 托管状态与退出清理（L2622-2664 相应段）；`main.rs` 无关 WebView2 的部分保留。
- 根 `package.json`：`package:windows:native` 等脚本改指向新默认；`scripts/collect-release-artifacts.mjs` 的 Linux 说明文案（L100-104，提到 OCR WASM/Sharp glibc）改写；`scripts/package-linux.mjs` 无结构改动。
- transport 的 `callSidecar`/`startSidecar` 与相关状态（transport.ts:272-276/415-461/683/940-968/971-978）删除；Tauri 端 `engine://line`/`engine://log` 事件随之移除。
- **Gate**：三平台打包产物目录审计——无 `engine/`、无 Node 二进制、无 `node_modules`；安装包体积记录（预期 NSIS ~50MB 级）；WebView2 干净环境首启冒烟。

### 阶段 8：删除 node-embed 路线

- 删 `.github/workflows/node-embed-sdk.yml`、`scripts/build-node-embed-sdk.ps1`、`scripts/node-embed-manifest-exporter.cs`、`scripts/build-windows-embedded.mjs`、`scripts/package-windows-portable.mjs`、`scripts/check-embedded-engine.mjs`。
- 删 `tauri.windows-embedded.conf.json`、`Cargo.toml` 的 `node-embed` feature、`build.rs:13-336`、`native/node_embed.cpp`、`lib.rs:494-546`、`main.rs:5-9` 分流。
- 删 `packages/engine` 的 `build:embedded` script、`scripts/build-embedded.mjs`、`scripts/embedded-mupdf-entry.mjs`、产物 `engine-embedded.cjs`（115MB）。
- 根 `package.json` 的 `package:windows*` 系列脚本收敛为单一默认路径。
- **Gate**：`cargo check`（三目标）、`pnpm typecheck`、全量构建通过；仓库内 `grep -r "node-embed\|engine-embedded\|--engine-child"` 归零（文档除外）。

### 阶段 9：删除 Node 引擎实现与依赖清理

- 删 `packages/engine/src/` 的 Node 执行层：`rpc.ts`、`jobs.ts`、`serve/`、`index.ts`（CLI 入口）、`lib/invoice-organizer.ts`（功能已由 Rust host + Worker 覆盖）、`tools/` 中仅 Node 使用的双实现（`image.ts`、`convert.ts`、`ocr.ts` Node 路径、`export.ts` 的 ExcelJS 路径等；共享模块 pdf-lib/docx/jszip 系保留）。
- `packages/engine/package.json`：删 `sharp`、`@img/sharp-wasm32`、`onnxruntime-node`、`exceljs`、`fontkit`；`build`（engine.mjs esbuild）与 externals 策略删除；`test:tools` 指向阶段 0 的浏览器 harness；`dev:engine`/`serve:http` 删除。保留 `paddleocr`、`onnxruntime-web`、`mupdf`。
- `lib/ocr.ts` 的模型目录解析（L95-106 的 `engine/ocr-models` 候选路径）收敛为前端资产单一来源；`prepare-ocr-runtime` 的模型搬运职责并入前端构建。
- 许可与文档：删 `public/licenses/Node.js-*.txt` 两份；改 `THIRD_PARTY_NOTICES.md` Node 章节、`docs/LICENSING.md`、`generate-license-inventory.mjs` 的 external-runtime 条目、README sidecar/嵌入相关段落、根 package.json description；`docs/single-exe-runtime-migration.md` 顶部标注"已由本计划取代，node-embed 路线终止"。
- **Gate**：`pnpm install` 后 workspace 无 sharp/onnxruntime-node/exceljs；全量 golden 回归（浏览器 harness）通过；`pnpm tauri dev` 冒烟。

### 阶段 10：发行验收

- Windows x64 NSIS + portable ZIP（纯应用文件，无 WebView2 内嵌）、macOS DMG、Linux x64/ARM64 AppImage/DEB/RPM 全矩阵构建。
- 干净虚拟机验收：安装目录审计（零旁置运行时）、首启、按工具分类抽检（PDF 页面组/转换组/OCR/图像/加密/发票）。
- 与旧版安装包体积、冷启动、内存占用对比数据落档。
- **Gate**：全部通过后打 tag，本计划完结。

## 风险与缓解

- **WKWebView/WebKitGTK 与 Chromium 的编码差异**：`convertToBlob` 的 WebP 编码在旧 WKWebView 不可用（此前由 sharp 回退掩盖）。缓解：阶段 4 能力探测落地后，WebP 输出在缺失环境显式降级为 PNG+提示；如需保真，后续引入纯 JS/WebP-wasm 编码器。
- **MuPDF WASM 与 MuPDF 原生的容差差**：同为 1.28.x，但极端损坏文件行为可能不同。缓解：阶段 2 用故意损坏样例扩展 golden。
- **测试基准失效**：删除 Node 实现即失去对照 oracle。缓解：阶段 0 golden 快照入库 + 阶段 6 灰度全量回归，两者都绿才进阶段 9。
- **回滚**：阶段 7 之前所有改动不改变默认行为（sidecar 仍在）；阶段 7 单独成 commit/tag，可整体 revert。
- **长尾用户输入**：灰度期若某类 `handled:false` 命中率高，按数据决定补实现还是显式错误（决策 2 的执行口）。

## 规模预估（粗）

| 阶段 | 规模 |
|---|---|
| 0 基线/harness/去重 | 大（测试基建为主） |
| 1 错误对齐 | 小 |
| 2 PDF 兜底 | 中 |
| 3 字体 | 中 |
| 4 图像/OCR | 中 |
| 5 发票/目录 | 小 |
| 6 灰度 | 小 |
| 7 切换发行 | 中（删除为主） |
| 8 删 node-embed | 小（纯删除） |
| 9 删 Node 实现 | 大（删码+测试迁移收口） |
| 10 验收 | 中 |
