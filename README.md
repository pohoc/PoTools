# PoTools 工具箱

PoTools 是本机文件处理工作台，提供 PDF、图片、Office/OFD/EPUB、OCR 与时间、密码学、开发辅助等工具。**全部工具逻辑由 Rust 实现**：桌面以原生库运行（Tauri 宿主），浏览器以 WebAssembly 在 Web Worker 中运行，两端行为同源。UI 为 Vite + React + TypeScript，只承担展示、任务编排与浏览器专属能力（PDF.js 渲染、Canvas、ONNX 推理）。

---

## 1. 架构

```
┌──────────────────────── apps/web（界面与浏览器宿主）────────────────────────┐
│ React 工具页 / 任务队列 / 设置 · 契约层: core-protocol/core-contract（纯类型） │
│ 宿主层: transport 路由 · embedded-jobs 任务编排 · embedded-engine Worker 池   │
│ 浏览器能力 adapter: PDF.js 渲染/裁剪 · Canvas 编码 · PaddleOCR 推理          │
└──────────┬──────────────────────────────────────────┬──────────────────────┘
     Web Worker（浏览器与桌面 WebView 共用）        Tauri IPC（仅桌面）
           ▼                                          ▼
┌────────── packages/engine（Rust，单一实现）─────────────────────────────────┐
│ dispatch(): text→crypto→developer→image→pdf_basic→pdf_extra→pdf_convert     │
│ 96 个能力 + OCR/图片导出支撑（表格重建、XLSX、图像解码等 WASM 导出）            │
│ native 特性: filesystem/invoice/network/shell 等特权服务（wasm 构建编译期排除）│
└──────────┬──────────────────────────────────────────────────────────────────┘
           ▼ potools-core（Rust）
   协议类型 · 页码解析 · 字段 schema · 密码强度 · 证件照预设
   catalog/*.json 经 include_str! 内嵌——UI 表单、默认值、参数校验的单一事实源
```

要点：

- **一份引擎，两种宿主**。桌面通过 `engine_run_file_tool` / `engine_run_text_tool` IPC 直调原生 Rust（路径传文件、零拷贝）；浏览器 Worker 调用同一 crate 编译的 WASM `dispatch`（无磁盘权限时以字节传输）。96 个引擎能力由 `toolCapabilities` 声明，并有测试逐一对账 dispatch，清单与实现不会漂移。
- **浏览器专属能力留在 apps/web adapter**：PDF.js 渲染、Canvas 编码、PaddleOCR 推理是浏览器技术，负责产出像素/字节；判定、布局规则与序列化全部在 Rust。数据经 `runtimeData` 单向传入（内容框、墨水占比、文本 runs、区域裁剪、OCR 文本）。
- **OCR 在本地运行**：PP-OCRv6 模型随应用资源分发（`apps/web/public/models/ocr/`），onnxruntime-web WASM 推理，识别结果的表格重建与 XLSX 导出在 Rust 完成。
- **产物先落临时目录**（`$TMPDIR/potools/jobs/<jobId>/`），设置输出目录后再复制，另存/重存不丢历史。
- 选项表单由 catalog 字段 schema 驱动，一份定义同时驱动 UI 渲染与引擎解析。

## 2. 仓库布局

```
apps/web          界面、任务编排、Worker 池、浏览器能力 adapter、OCR 模型资源
apps/desktop      Tauri 宿主：IPC wrapper 与受限系统服务（invoice 归档等）
packages/core     Rust 协议/目录 crate（catalog/*.json 为工具元数据事实源）
packages/engine   Rust 工具引擎（native + wasm 双目标）
packages/ui       共享 UI 组件（shadcn/ui vendor + 应用级组合）
scripts           构建/打包/样例脚本（wasm:build、发行包收集、图标、许可清单）
docs              许可与发布检查文档
samples           引擎自测样例（pnpm samples 生成）
```

`packages/core` 与 `packages/engine` 均为纯 Cargo 包（无 TS 实现、无 Node 运行路径）。web 侧的 `'core'` 别名指向纯类型契约（`core-protocol.ts` / `core-contract.ts`），运行时绑定收敛在 `core-bindings.ts`；`packages/engine/wasm/pkg/` 为构建产物（git 忽略，`predev`/`prebuild` 自动重建）。

## 3. 工具能力

目录收录 **98 个工具**（另有 21 个证件照尺寸预设作为选项数据），按任务域分组浏览：页面管理、页面版式、标注、转换、提取、优化、图片处理、文档信息、时间、密码学、开发辅助、网络、发票整理。

| 域 | 代表能力 |
| --- | --- |
| 页面管理 | 合并、拆分（含可视化选点）、组织（拖拽重排）、旋转、提取、删除、删除空白页（墨水占比判定） |
| 页面版式 | 尺寸调整、裁剪（含自动贴合内容）、页边距、N 合 1、发票合并（去重+自动裁边） |
| 标注 | 中文水印、页码、页眉页脚（模板变量、9 宫格定位、平铺） |
| 转换 | PDF↔图片、图片→PDF、PDF→Word/Excel/PPT/Markdown/HTML/CSV/RTF/EPUB/OFD、OFD→PDF、Markdown→PDF |
| 提取 | 提取文字（逐页/合并/页码标记）、提取图片（原件或转格式）、OCR 文字/表格（本地模型）、文档属性 |
| 优化 | 压缩（图像重采样+对象流+元信息清除）、修复（交叉引用重建） |
| 图片处理 | 压缩、缩放、裁剪、旋转翻转、格式转换（含 TIFF 预览/转换）、证件照、抠图、水印清除、元信息清理 |
| 时间 | 时间戳转换、日期差/计算、工作日、时区板、时长、Cron 解析与说明、相对时间、金额转换 |
| 密码学 | 哈希/HMAC/文件校验、Base64、JWT、AES、RSA、TOTP、X.509、密码生成/强度、UUID、文件 Base64、bcrypt |
| 开发/网络 | JSON/XML/YAML、正则测试、进制/编码、颜色、URL/IPv4/IPv6、robots/SPF/DMARC、DNS/Ping/TCP、IP 归属 |

完整清单与每项工具的选项默认值见 `packages/core/catalog/*.json`（单一事实源，勿在别处手工复制）。发票整理为独立工作流页（目录扫描 → 解析字段 → 归档/撤销），经桌面特权服务执行。

## 4. 开始使用

前置：Node 20.19+ 或 22.12+、pnpm 12、Rust stable（`rustup default stable`）、wasm-bindgen-cli 0.2.129（`wasm:build` 需要）。macOS 需 Xcode Command Line Tools。

```bash
pnpm install

pnpm dev              # 浏览器版 http://127.0.0.1:5199（引擎以 WASM 在 Worker 运行）
pnpm tauri dev        # 桌面版（原生引擎 + 特权服务）
pnpm wasm:build       # 单独构建引擎 WASM bindings
pnpm samples          # 生成/刷新引擎自测样例
```

## 5. 验证与质量门禁

CI 会跑的全部门禁，本地一条命令即可复现：

```bash
pnpm check                                         # 版本一致性 + lint + 类型 + Rust fmt/clippy/test
```

单条门禁：

```bash
pnpm version:check                                 # 各处清单版本与根 package.json 一致
pnpm lint                                          # oxlint：正确性、React hooks、未使用代码（可 --fix）
pnpm typecheck                                     # web / ui 契约与宿主类型
pnpm rust:fmt                                      # cargo fmt --check（三个 crate）
pnpm rust:clippy                                   # cargo clippy --all-targets -- -D warnings
pnpm rust:test                                     # cargo test（core / engine / desktop）
pnpm rust:check:wasm                               # 引擎 wasm32 目标编译（native 服务须被排除）
pnpm licenses:check                                # 随包许可清单与依赖图一致
pnpm test:tools                                    # 浏览器端到端金样回放（需先 pnpm wasm:build）
```

工具链由 `rust-toolchain.toml`（stable + rustfmt + clippy + wasm32）与 `rustfmt.toml` 声明。
Rust 侧用 `cargo fmt` + `clippy`；TypeScript 侧用 `oxlint`——**刻意不用 ESLint**：
`typescript-eslint` 尚不支持本仓库使用的 TypeScript 7，而 oxlint 是独立二进制、不依赖
TS 编译器 API，覆盖同样的正确性与 hooks 规则。

约束：功能/服务文件不超过 500 行；`packages/engine/src/tools/capabilities.rs` 的
`SUPPORTED` / `ENGINE_ONLY` / `ADAPTER_HANDLED` 三份登记与目录 `catalog/*.json`
由测试双向对账（新增目录项却忘了实现会直接测试失败）；引擎 `run_tool` 有 panic 隔离，
panic 转成 `internal` 错误；web build 前有 Rust WASM 启动 smoke
（`apps/web/scripts/check-embedded-registry.mjs`）。

颜色 token 按角色使用：`--ui-line` 只用于装饰性分隔（卡片、面板、弹层、分隔线），
`--ui-control-line` 用于「边框即识别手段」的交互控件（输入类、复选/单选、分段控件、
描边按钮、滑块拇指、拖放区）——后者是 WCAG 2.2 SC 1.4.11 要求的 3:1 层级。

界面多视口审计：浏览器打开 `http://127.0.0.1:5199/ui-audit.html#/`，在 1440/1180/1024/900/780 五个宽度下渲染实例并报告横向溢出与被裁切元素。

## 6. 打包与发行

- macOS：`pnpm package:macos` → `release/macOS/`。
- Windows：`pnpm package:windows:x64` / `package:windows:x86`（NSIS）→ `release/Windows/`；安装版启动时检查并静默安装 WebView2（需网络）。
- Linux：在目标架构原生主机运行 `pnpm package:linux` → `release/Linux/`。x64/ARM64 配 AppImage、DEB、RPM（Ubuntu 22.04 / Debian 12 基线）；ARMv7 hard-float、PowerPC64 LE、s390x 配 DEB、RPM（需 glibc 2.36+）。构建机需 Tauri Linux 依赖（`libwebkit2gtk-4.1-dev`、GTK、OpenSSL、AppIndicator、librsvg）。信创发行版（UOS/麒麟/openEuler）须按具体版本验证 WebKitGTK 4.1、GTK 3 与 glibc，构建成功不等于发行认证。
- 全平台发行包不含 Node 运行时或旁置引擎进程：引擎编进 Tauri 宿主，并以 WASM 形式供浏览器 Worker 独立运行。
- `apps/desktop/.cargo/config.toml` 将 crates.io 指向 rsproxy.cn 镜像（直连易卡死）；删除即回官方源。
- 图标单一美术源 `apps/web/public/app-icon.svg`，`pnpm icons` 生成 favicon 与 `apps/desktop/icons/*`。

## 7. 设置项

设置页按外观 / 输出 / 存储 / 高级 / 引擎 / 关于分组，`#/settings?tab=engine` 可直达。

| 项 | 说明 |
| --- | --- |
| 默认输出目录 | 留空则结果留在临时目录，可逐条另存/下载 |
| 文件名模板 | `{name} {tool} {index} {i} {total} {range} {date} {time}`；同名自动追加 `(2)` |
| 并行任务数 | 任务编排并发度，默认 1 |
| 中文字体文件 | 转换类工具嵌入 CJK 字形用；留空由宿主探测系统字体候选 |
| 临时目录保留天数 | 启动时自动清理更早任务目录；存储页可查看占用并手动清理 |
| 引擎自检 | 运行方式、协议版本、能力标志与字体探测结果 |

## 8. 已知边界

- **加密 PDF**：带真实用户口令的文件明确报错，不做解密；空口令文件可直接处理。
- **书签/表单/注释**：合并与组织页面不迁移大纲（书签）；AcroForm 字段与注释不保证保留。
- **转换精度**：PDF→Word/Excel/PPT 按版面重建可编辑内容，复杂版式精度有限；OFD 矢量路径（PathObject）暂不导出；PDF→OFD 文字模式对超大字体只登记字体名（>3 MB）。
- **OCR**：模型随应用分发并在本地推理；扫描件发票归档识别标注 `needs-ocr`，表格按文字位置推断行列，导出后需人工复核。
- **图片导出**：PDF 内嵌图位置由内容流 `cm ... Do` 反算后从页面光栅裁切，异常变换（旋转/斜切）取包围盒。

## 9. 版权与许可

作者 / Author：**pohoc** · 邮箱：**po.hoc4@gmail.com**

PoTools 自有源代码采用 [MIT 许可证](LICENSE)。第三方组件与模型（Rust crates、pdf.js、onnxruntime-web、PaddleOCR 模型等）保留各自许可证，随包清单见 `apps/web/public/licenses/`，许可边界与发布检查见 [docs/LICENSING.md](docs/LICENSING.md)。应用不上传用户文档，OCR 与全部处理均在本机完成。
