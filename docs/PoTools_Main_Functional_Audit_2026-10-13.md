# PoTools `main` 当前功能及新规范符合度审计报告

- **审计日期**：2026-10-13
- **仓库**：[pohoc/PoTools](https://github.com/pohoc/PoTools)
- **代码基线**：[`77b3c2ef30fb49a02cfeb8894d2cf71bf4734ea2`](https://github.com/pohoc/PoTools/commit/77b3c2ef30fb49a02cfeb8894d2cf71bf4734ea2)
- **规范基线**：[`docs/README.md`](https://github.com/pohoc/PoTools/blob/77b3c2e/docs/README.md)，包括工程、交互、安全、质量和工具全链路开发规范
- **审计方法**：通过 GitHub 读取代码、Catalog、CI 工作流、Release 和规范文件；未进行本地完整编译、打包运行、GUI 操作或真实样本回归。本文“代码确认”不表示漏洞已被动态复现。

## 1. 执行摘要

PoTools 已有可用的跨宿主工具框架和广泛的格式处理功能，当前主要矛盾并不是工具数不足，而是：**安全边界与任务生命周期存在可确认的设计缺口；工具交互尚未按任务类型分层；自动化验收不足以证明工具级正确性**。

**简要判断**：

- 核心架构：已具备（Rust Core/Engine、Worker/WASM、Tauri、React UI 与多平台打包）。
- 工具登记：98/98 个 Catalog ID 唯一；其中 49 个 `text` layout，49 个非 `text`，39 个 `interaction: live`。
- 交互模型：规范提出七种工具体验，但生产代码仍使用 `layout` 和字段类型分配通用工作台，专用组件覆盖局部场景。
- Native 文件权限：部分文件命令正确执行 `PathGrants` 检查，发票/目录浏览/临时管理及授权配置入口尚有遗漏。
- 任务可靠性：Worker 取消与 Native 文件执行取消不一致；大文件存在无必要的 JS↔Rust 预读/复读。
- 质量保障：合并后 main 的 GitHub CI 通过，但 `test:unit`、`test:tools` 尚未成为 CI 和 `pnpm check` 的强制项。
- 分发：仓库有 v0.1.0 draft Release（15 个附件），但尚未正式发布；Release workflow 内存在版本号硬编码。

## 2. 功能版图（代码确认，不代表全量正确性验收）

| Catalog 领域 | 工具数 | 当前能力概览 | 新规范下的主要缺口 |
| --- | ---: | --- | --- |
| 页面管理 | 6 | 合并、拆分、组织、旋转、提取、删除页面 | PDF 合并缺乏整合的页面级预览与结果确认；删除/提取可加强可视选页 |
| 标注 | 3 | 水印、页码、页眉页脚 | 目标页面上的实时位置/边距/层级预览尚非统一模式 |
| 文档元数据 | 3 | PDF 元数据、图片信息、图片元数据清理 | 读取/修改、隐私清理差异与副作用反馈需强化 |
| 优化 | 3 | PDF 压缩、去空白页、修复 | 质量变化、空白判定依据和不可逆风险应有结果对照 |
| 转换 | 13 | PDF ↔ 图片、Word、Excel、PPT、Markdown、HTML、CSV、OFD 等 | 成品保真、限制提示、导出预览及平台回归尚未逐项验收 |
| 页面布局 | 5 | PDF 缩放、裁剪、边距、N-up、发票合页 | 缺少普遍适用的所见即所得画布/排列预览 |
| 提取与 OCR | 4 | 图片/文字提取、OCR 文字与表格 | 识别置信度、人工校核、结构编辑与资源性能验收待补 |
| 发票整理 | 1 | 扫描、识别、人工字段修订、归档、撤销 | Native 授权是安全阻断项；预提交复核可加强 |
| 图片处理 | 9 | 压缩、缩放、裁剪、旋转、转换、抠图、证件照、打印、修复 | 三项具专项 ImageStudio；多数仍以文件+选项为主要交互 |
| 时间 | 9 | 时间戳、日期差、工作日、Cron、时区、格式化等 | 日期/时区语义、结构化时间轴/表格与操作反馈待设计 |
| 密码学 | 19 | 编码、哈希、HMAC、JWT、AES、RSA、UUID、TOTP 等 | JWT 分区解析与验签可信状态；生成器重新生成；敏感数据 UI |
| 财务 | 1 | 金额大小写转换 | 格式/精度与结果直接复用 |
| 开发辅助 | 9 | JSON/XML/YAML、正则、进制/颜色/大小写、robots 等 | 编辑器、匹配高亮、错误定位和结果结构化 |
| 网络 | 13 | DNS、IP 子网、UA、SPF/DMARC、端口、本机网络等 | 网络请求来源与授权、CSP、超时、结果诊断与时效 |

**分布**：`layout` = text 49、standard 44、image-grid 2、organizer 1、splitter 1、metadata 1。39 个 live 工具走 250ms 的自动触发节奏；对于所有 `requiresInput === false` 的文本工具，自动运行逻辑的“fileless”判断无法进一步区分真正的随机生成器与输入转换工具，需按语义重构。

### 已经存在、应复用的交互基础

- `PageGrid.tsx`：PDF 页面缩略图编排、选择、旋转、复制、删除。
- `SplitCanvas.tsx`：可视分组拆分与产物数量预览。
- `ImageStudioEditor.tsx`：抠图、证件照和水印修复三种专用图片场景，包含编辑/结果预览。
- `InvoiceOrganizerPage.tsx`：桌面特权流程，有来源/目标文件夹选择、批量扫描、逐条字段修订、命名规则、冲突策略、归档和撤销。
- `FileList.tsx` / `FilePreviewDialog.tsx`：文件排序、点击预览以及统一 Viewer。
- `ResultPanel.tsx`：任务进度、文件结果与保存、下载、打开、重跑等动作。
- 桌面输出：`folder`（指定目录）与 `source`（跟随源路径）两档；源目录写入已有一个原生确认入口，但不能消除其他可任意授权的 IPC。

## 3. 对标规范的重大差距（优先级）

### P0：Native 权限边界（先修复）

| 编号 | 静态代码证据 | 问题及风险 | 下一 PR 的最低验收 |
| --- | --- | --- | --- |
| SEC-01 | [`apps/desktop/src/lib.rs#L309-L342`](https://github.com/pohoc/PoTools/blob/77b3c2e/apps/desktop/src/lib.rs#L309-L342) | `invoice_scan_list`、`invoice_read_candidate`、`invoice_archive` 未在 IPC 入口调用 `PathGrants`。有 WebView IPC 能力的脚本可能尝试未经用户授予的本地路径。 | 直接 invoke 任意未授权来源/目标都拒绝，且文件及目录元数据不泄露、无文件副作用。 |
| SEC-02 | [`apps/desktop/src/lib.rs#L656-L687`](https://github.com/pohoc/PoTools/blob/77b3c2e/apps/desktop/src/lib.rs#L656-L687)，[`#L351-L364`](https://github.com/pohoc/PoTools/blob/77b3c2e/apps/desktop/src/lib.rs#L351-L364) | `set_output_dir` / `set_temp_dir` 可从自由 IPC 参数增加目录 grant，`temp_clean` 依赖自由指定 root。与只信赖真实原生用户手势的规范冲突。 | 任意参数不可直接获得特权目录范围；清理只接受可信应用 temp root，负面测试覆盖符号链接和越界路径。 |

**风险边界**：这里是 WebView/IPC 信任边界问题；本次未证实任意远程网站能够零点击利用，也未进行破坏性漏洞复现。

### P1：高影响运行、交互与产品一致性问题

| 编号 | 现状及证据 | 影响 | 修复方向 |
| --- | --- | --- | --- |
| SEC-03/04 | [`browse_directories`](https://github.com/pohoc/PoTools/blob/77b3c2e/apps/desktop/src/lib.rs#L427-L430)、`temp_usage` 接受自由路径；底层浏览甚至会向父目录回退 | 可探查非预期本地元数据 | 全部目录浏览/用量命令经过可信路径验证；防父目录越界。 |
| RUN-01 | [`transport.ts#L90-L105`](https://github.com/pohoc/PoTools/blob/77b3c2e/apps/web/src/lib/transport.ts#L90-L105) 先把路径读为 JS bytes；[`embedded-jobs.ts#L104-L116`](https://github.com/pohoc/PoTools/blob/77b3c2e/apps/web/src/lib/embedded-jobs.ts#L104-L116) 在排队前解析全部文件；Native 又按路径读文件 | 大文件重复读、IPC 与 JS 内存占用 | Native-first 输入引用；只对需要 Worker/raster 的工具按需物化。 |
| RUN-02 | [`embedded-jobs.ts#L137-L151`](https://github.com/pohoc/PoTools/blob/77b3c2e/apps/web/src/lib/embedded-jobs.ts#L137-L151) 取消只通知 Worker，原生命令没有 token；`publish` 不防 cancelled 后的迟到 success | UI 声称取消，Native 仍可执行/写文件，终态可能反转 | Native cancellation token、终态不可逆、写出前二次检查。 |
| RUN-03 | [`transport-shared.ts#L5-L12`](https://github.com/pohoc/PoTools/blob/77b3c2e/apps/web/src/lib/transport-shared.ts#L5-L12) 重复维护 Native 文件白名单；Rust engine 又另有 capability | 跨平台实际执行不统一、能力回退难预测 | Catalog / Rust 导出的 host route manifest，并在 CI 双向对账。 |
| UX-01 | [`ToolPage.tsx#L430-L474`](https://github.com/pohoc/PoTools/blob/77b3c2e/apps/web/src/pages/ToolPage.tsx#L430-L474) 按 textarea/main section 决定主编辑器；除特殊 ID 外共用工作台 | JWT / Cron / JSON / 正则 / 生成器同质化，违背七种 UX 模型 | 七类模板、局部组件复用；首批迁移七个代表工具。 |
| UX-02 | [`ResultPanel.tsx#L489-L555`](https://github.com/pohoc/PoTools/blob/77b3c2e/apps/web/src/components/ResultPanel.tsx#L489-L555) 通过 `password-gen.txt`、`color-values.txt` 等文件名选择少数视觉呈现，其余通常 `<pre>` 文本 | 报告文本不是 JWT、Cron、正则或计算结果的最佳消费界面 | 引入结构化结果 schema / renderer；避免以输出文件名推断工具语义。 |
| UX-03 | [`useToolDraft.ts#L203-L236`](https://github.com/pohoc/PoTools/blob/77b3c2e/apps/web/src/lib/useToolDraft.ts#L203-L236) 统一 250ms live；校验失败直接 return，不清空旧结果；随机生成器也随设置变更刷新 | 结果可能与新输入不一致，用户复制旧数据；生成值被意外刷新 | generation/stale 状态和 per-tool cadence；随机值保留直至明确再生成。 |
| UX-04 | [`ToolPage.tsx#L522-L560`](https://github.com/pohoc/PoTools/blob/77b3c2e/apps/web/src/pages/ToolPage.tsx#L522-L560) 专用 ImageStudio 仅针对 `image-cutout` / `image-id-photo` / `image-watermark-clean`；`image-crop` 等仍是普通文件表单 | 图片/PDF 编辑缺少一致的直接操作画布和前后对比 | 抽象 VisualEditorWorkspace，先迁移 `image-crop` 再覆盖 PDF crop/nup。 |
| NET-01 | [`tauri.conf.json#L29`](https://github.com/pohoc/PoTools/blob/77b3c2e/apps/desktop/tauri.conf.json#L29) 的 `connect-src` 不含外站；[`embedded-jobs.ts#L28-L47`](https://github.com/pohoc/PoTools/blob/77b3c2e/apps/web/src/lib/embedded-jobs.ts#L28-L47) 向外站 fetch IP 查询 | 打包 Tauri 的 IP 查询可能被 CSP 阻止；必须实测确认 | Native 受控网络桥或明确的最小 CSP 策略；发布包测试。 |
| QA-01 | [`package.json#L40-L44`](https://github.com/pohoc/PoTools/blob/77b3c2e/package.json#L40-L44)、[CI](https://github.com/pohoc/PoTools/blob/77b3c2e/.github/workflows/ci.yml) | `test:unit` / `test:tools` 不属于强制门禁；最低 Node 运行 `.ts` 用例有兼容问题 | 兼容测试 runner，CI 加全量 golden / unit / 权限与交互检查。 |
| REL-01 | [Release workflow](https://github.com/pohoc/PoTools/blob/77b3c2e/.github/workflows/release.yml) | tag 派发构建且部分资源与 updater JSON 名仍硬编码 `0.1.0` | 从 tag 动态推导版本，非 0.1.0 演练 tag 与 updater 元数据校验。 |

### P2：可维护性与系统性体验问题

- [`embedded-jobs.ts#L404-L417`](https://github.com/pohoc/PoTools/blob/77b3c2e/apps/web/src/lib/embedded-jobs.ts#L404-L417) 对 unsupported 结果发布 failed 后立即删除本地 Job Map 项；刷新可能丢失失败记录。
- [`ToolPage.tsx`](https://github.com/pohoc/PoTools/blob/77b3c2e/apps/web/src/pages/ToolPage.tsx) 643 行、[`OptionForm.tsx`](https://github.com/pohoc/PoTools/blob/77b3c2e/apps/web/src/components/OptionForm.tsx) 819 行、[`desktop/src/lib.rs`](https://github.com/pohoc/PoTools/blob/77b3c2e/apps/desktop/src/lib.rs) 806 行，超过新规范建议的约 500 行；这是维护性建议而非旧仓库已有硬性要求。
- Catalog 的字段 key 唯一性、默认值与 schema 类型、语言键完备性、宿主能力必须有更严格的自动对账。
- Win7 Electron22 属于维护与安全支持例外，浏览服务路径边界使用字符串前缀检查需整改；不应宣称与受支持 Tauri 桌面同一安全水平。
- 原始多语言、本地文件、PDF/图片格式的质量与实际性能尚未通过针对性的 GUI、E2E、设备测试验证。

## 4. 与新规范的模块符合度（定性评价）

| 新规范 | 当前状态 | 依据 |
| --- | --- | --- |
| 工程分层 | **部分符合** | Core/Engine/Web/Native 分层清晰，但入口耦合与工具 Native 路由重复。 |
| 工具全链路开发 | **部分符合** | Catalog→WASM→UI→Job→Artifact 路径存在，但路由/runtimeData/跨宿主验收未自动一体化。 |
| 七类交互体验 | **主要未落实** | 生产字段仍以 `layout` + `interaction` 描述，尚未实施 RFC `ToolExperience` 与七类模板。 |
| 输入/输出预览 | **局部符合** | PDF 页面操作、三项图片专项和通用文件预览可复用；非所有视觉工具具实时画布。 |
| 安全信任边界 | **关键项不符合** | 部分 Native IPC 权限入口与 grant 来源不满足特权侧强制校验。 |
| 任务取消/失败恢复 | **部分不符合** | UI 有取消、重试、进度和 Job Map，但 Native 取消传播和终态不变性未满足目标。 |
| 质量与验收 | **部分符合** | main CI 绿，但不含 `test:unit`、`test:tools`；缺 GUI 和发行包验收。 |
| 发布与维护 | **有流水线，待增强** | v0.1.0 是 draft release；版本号硬编码和 Win7 维护风险未消除。 |

## 5. 建议执行计划与验收定义

### 阶段 A：安全和数据边界（阻断）

1. 补全发票扫描/读取/归档、目录浏览、用量统计、临时清理的 Native 授权检查。
2. 区分可持久化的输出设置与真正授予的写权限；移除任何 JS 自由 mint 权限的路径。
3. 对未经授权 IPC、路径穿越、符号链接、无权限目录、用户拒绝进行自动回归。

**完成条件**：所有特权入口有明确 allow/deny 单测；拒绝后不泄露元数据、源数据不受改写、目标目录无新文件。

### 阶段 B：任务稳定性与执行路由

1. Native-first FileRef，避免全文件 JS 预读；仅 adapter 真需要时申请 bytes。
2. 为 Native 任务增加取消 token、协作式检查和终态不可逆校验。
3. 统一能力路由登记，补 Worker/Tauri 不同结果的契约测试；修复失败快照被删除。
4. 打包版实测外联工具、资源限额及异常恢复。

**完成条件**：典型大文件任务有读字节、内存和耗时基线；取消后无正式产物并保持取消态；所有 98 个 ID 均可被路由诊断。

### 阶段 C：七类工具交互样板

优先实现七个代表工具：

- `json-format`：双编辑器 + 错误行列 + 过期结果清理。
- `jwt`：Header、Payload、Signature 分区；解析与验证严格分离。
- `cron`：当前时区语义与未来 N 次运行表。
- `password-gen`：生成策略、可阅读的随机值和明确的重新生成操作。
- `image-crop`：可拖动框、像素尺寸与导出结果同源。
- `merge`：多 PDF 文件与页顺序可复核、明确合并成品预览。
- `invoice-organize`：扫描→预检→字段校对→归档确认→撤销，权限闭环。

**完成条件**：七个样板各有 UI 录屏、操作用例、键盘路径、异常/重试及 Web/Tauri 能力差异说明。再分批推广其余工具，而非一次性重写。

### 阶段 D：自动化验收与发布

1. Catalog、i18n、字段默认值、结果类型、能力路由检查进入 CI。
2. `pnpm test:unit` / `pnpm test:tools` 作为强制项，选兼容声明 Node 的测试运行器。
3. 非 v0.1.0 的 tag 模拟发布，验证动态版本资源、签名、正式包启动和 updater。
4. 维护 98 工具矩阵的 `Observed → In progress → Verified` 状态，逐项留下样例/平台证据。

## 6. 可核实的当前交付状态

- **main SHA**：`77b3c2e`，是 PR #1 合并的文档更新；该 PR 本身不含工具运行代码整改。
- **合并后 CI**：[`38330372188`](https://github.com/pohoc/PoTools/actions/runs/38330372188) — completed / success。
- **release**：GitHub v0.1.0 为 draft（附件 15 项）；未发布，不代表最终安装和自动更新已验收。
- **审计限制**：此次以静态阅读和 GitHub CI 元信息为准，没有动态证明工具正确率、用户任务完成率、安全漏洞影响范围或性能改善幅度。**报告优先级是整改顺序，不是 98 个工具的失败率或商业成熟度评分。**

## 7. 推荐资料入口

- [开发文档索引](https://github.com/pohoc/PoTools/blob/77b3c2e/docs/README.md)
- [工具交互标准](https://github.com/pohoc/PoTools/blob/77b3c2e/docs/standards/TOOL_INTERACTION.md)
- [引擎与安全标准](https://github.com/pohoc/PoTools/blob/77b3c2e/docs/standards/ENGINE_SECURITY.md)
- [质量验收标准](https://github.com/pohoc/PoTools/blob/77b3c2e/docs/standards/QUALITY_GATES.md)
- [98 项工具目标交互矩阵](https://github.com/pohoc/PoTools/blob/77b3c2e/docs/audits/TOOL_UX_MATRIX.md)
- [代码问题登记](https://github.com/pohoc/PoTools/blob/77b3c2e/docs/audits/IMPLEMENTATION_GAPS.md)

**最终建议**：先修安全授权与任务取消（避免工具看似成功但用户数据不受控），随后用七个样板工具建立按任务类型的 UX 框架；在任何大规模改造前将工具 goldens、前端单测与 Native 授权测试并入 CI。保留 Rust 算法和现有 PDF/图片编辑组件，减少不必要的引擎重写。
