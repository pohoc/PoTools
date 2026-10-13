# 工具交互与输出模式改造计划

> **历史记录 / 非现行规范**（2026-10-13 标注）：本文件保留当时的方案比较、阶段记录和原文中的状态表述。部分阶段内容已经在代码中落地，另有三档→两档等决策变化，不能将“阶段计划”或验收目标误读为当前已实现功能。新的统一规则见 [开发文档索引](../README.md)、[工具交互规范](../standards/TOOL_INTERACTION.md) 与 [98 项工具交互审计矩阵](../audits/TOOL_UX_MATRIX.md)。实际能力以代码及验收记录为准。

- 状态：草案（待批准）
- 日期：2026-10-12
- 来源：工具操作形态分析 + 输出目录双模式分析（会话结论沉淀）
- 关联文件：`packages/core/src/tools.rs`、`packages/core/src/fields.rs`、`packages/core/catalog/*.json`、`apps/web/src/pages/ToolPage.tsx`、`apps/web/src/components/OptionForm.tsx`、`apps/web/src/lib/useToolDraft.ts`、`apps/web/src/stores/engine.ts`、`apps/desktop/src/access.rs`

## 1. 背景与问题

| # | 问题 | 证据 |
| --- | --- | --- |
| P1 | 49 个文本类工具沿用 PDF 文件工具的「选项 → 运行按钮 → 结果」三段式；输入框作为普通字段躺在「选项」卡里。毫秒级纯变换被强制手动触发，落后于业界即时反馈的主流（jsoneditoronline、regex101、epoch 转换类全部 as-you-type） | `ToolPage.tsx:339-349`、`ToolPage.tsx:235-258` |
| P2 | 布局千篇一律：自由式仅 3 个工具实现，且是 `ToolPage.tsx` 里按工具 id 硬编码分支（color-convert / password-strength / invoice-organize），不可扩展 | `ToolPage.tsx:323-337` |
| P3 | 输出目录全局单一（用户设置，缺省 `~/Documents/PoTools`），无「跟随源文件」与「临时保留」档位；文件为中心的工作流要手动搬运产物，探索型使用会堆积垃圾文件 | `stores/engine.ts:35`、`runtime.rs:35-42` |

## 2. 目标与非目标

**目标**

1. 文本工具按操作特征（成本 / 副作用 / 迭代方式）获得两种交互节奏：`live`（输入即出结果，无运行按钮）与 `action`（保留显式运行）。
2. 文本工具的输入升级为页面主体（hero），选项紧凑化，不再把输入陈列在「选项」卡里。
3. 文件工具输出目录三档：**跟随源文件 / 固定输出目录（现状默认）/ 仅临时保留**。
4. schema 契约不变：`fields[]` 仍是 UI 生成与引擎校验的共享唯一来源（`fields.rs:1`），本计划只增加呈现/交互元数据。

**非目标**

- 不改任何引擎工具逻辑与既有字段语义。
- 不做「每工具手写页面」式完全自由化——自由化的是布局层，控件仍 schema 化复用 `OptionForm` 原语。
- 浏览器端不提供「跟随源文件」（无文件系统），其临时产物走既有下载路径。
- 不动主题 token 分层与无障碍基线（`--ui-control-line` / `--ui-line`、aria 关联）。

## 3. 设计决策

| # | 决策 | 理由 |
| --- | --- | --- |
| D1 | 工具级新增 `interaction: "live" \| "action"`，默认 `action` | 交互节奏由操作特征决定，与媒介（文本/文件）无关；判据见 §1 P1 分析 |
| D2 | 文本工具页按「textarea 即编辑器」规则重排：textarea 渲染为页面主体大编辑区，其余字段进紧凑选项卡；输入与结果双栏并排 | 免去 schema 加标记与 49 处 catalog 标注——text 工具里 textarea 天然就是主输入，规则零配置覆盖全部工具 |
| D3 | 输出做三档而非两档 | 「仅临时保留」端到端机制已存在（`stage_artifact` 先写 `temp_root/jobs/{job_id}` 再可选复制，`filesystem.rs:163-186`），只差把 `output.dir` 置空的入口 |
| D4 | 源目录写入走合规授权：复用 DirectoryPicker 既有授权，或首次写入时一次性原生确认后 `grant_write_dir` | `access.rs:1-33` 威胁模型明确：写授权只能来自用户手势或显式配置；禁止把文件授权静默扩大为父目录写授权 |
| D5 | action 白名单：4 个 `networkAccess` 工具（dns-lookup / ping-check / tcp-check / ip-lookup）+ 全部文件工具；aes/rsa/bcrypt 待实测后定 | 有耗时/网络副作用/不可逆风险的操作保留显式运行 |

## 4. 分阶段实施

### Phase 1 — schema 扩展与 live 交互

**改动清单**

- `packages/core/src/tools.rs`：`ToolDescriptor`（:49）新增 `interaction: Option<ToolInteraction>`，serde kebab-case，缺省 `action`；仿照 `network_access`（:67）的可选风格。
- `packages/core/catalog/*.json`：为 live 档工具标注 `"interaction": "live"`（清单见附录 A）。
- `apps/web/src/lib/useToolDraft.ts`：live 模式下输入/选项变更 debounce ≈250ms 自动走既有 `runInMemory`（:151-169）；运行中新变更合并为尾触发；卸载时取消定时器。
- `apps/web/src/pages/ToolPage.tsx`：text 布局分支按 `interaction` 渲染——live 隐藏运行大按钮（保留校验失败原因提示区），结果内联于输入下方；`TextRunPanel` 的 `onRetry` 语义保留。
- `apps/web/src/i18n/en.ts` / `zh-CN.ts`：新增 live 提示 key（如 `result.liveHint`「输入即自动转换，结果在此实时更新」）。

**验收**

- `pnpm check` 全绿（schema 变更过 rust fmt/clippy/test）。
- `pnpm test:tools` 金样 222 PASS / 0 DIFF 不回归（live 只改触发方式，不改引擎行为）。
- `pnpm tauri dev` 冒烟：json-format 输入即出结果；dns-lookup 仍需按钮。

**风险**：`visibleFields` 过 WASM 且曾是热路径（`OptionForm.tsx:164-167` 注释）——debounce 与既有 `useMemo` 模式保持一致，禁止在 render 中直调。

### Phase 2 — hero 输入与自由式布局（已实现，方案较原计划简化）

**实际改动清单**

- `apps/web/src/styles.css`：新增 `.text-hero-grid`——≥1200px 双栏（输入卡列 | 结果卡），窄窗口按工作流顺序堆叠。
- `apps/web/src/components/OptionForm.tsx`：新增 `hero` 变体——textarea 渲染为大编辑区（rows ≥16、min-h 300px，通过内联覆盖主题变量 `--ui-textarea-min-height` 实现层级），其余控件原语不变。
- `apps/web/src/pages/ToolPage.tsx`：text 分支重排为**对称卡片工作台**——左列 = 输入卡（main 区 textarea 成为大编辑器；无 textarea 的工具直接放单行字段）+ 选项卡（其余字段，重置在题头）+ 运行/状态行，右列 = 输出结果卡（等高拉伸）。两张卡均用 `@potools/ui` `Section`（标题内嵌题头）。
- 控件优化（参照 web 工具惯例）：`json-format` 缩进字段加 `showIf(mode=pretty)`（压缩模式下隐藏，如 jsonlint 类工具的上下文相关选项）；`case-convert` 的 7 个命名风格改为 chips 呈现；日期预设 chips 点击后输入框回显解析后的真实时间（`OptionForm.resolveDatePreset` 与引擎 `parse_relative_phrase` 语义逐一对齐，存储值仍为标识符以保留相对语义）。
- 第二轮控件巡检：12 个 5-8 选项的「模式类」下拉升级为 chips（hash 算法、base64 MIME、radix 字母表、jwt/rsa 模式、dns 记录类型、timestamp/date-diff/date-math/duration 的单位与风格）；页码范围字段的 `all/odd/even` 回显为 全部/奇数/偶数（存储值保持标识符，引擎本就双向接受）；为 7 个空默认输入补 placeholder（bcrypt 密码/哈希、regex 替换模板、spf includes/ipv4、dmarc 报告邮箱、user-agent）；`timestamp` 输入默认值从空改为 `now`——打开页面即回显当前时间并立即出结果，不再强制用户点击（其余必填空默认字段是真实用户内容，保留必填）。
- 第三轮控件巡检（文件工具侧）：5 个 5-8 选项下拉升级为 chips——`resize` 目标尺寸、`invoice-merge` 每页张数、`image-compress` 输出格式、`image-crop` 宽高比与位置。
- 不改 schema、不改 Rust（原计划的 `hero: Option<bool>` 字段被「main 区 textarea 即编辑器」规则取代）。

**验收**

- `pnpm lint` + `pnpm --filter @potools/web typecheck`。
- 无障碍走查：hero 输入的 label 视觉隐藏但读屏可达；`aria-invalid` / `role=alert` 行为与现状一致。

**风险**：草稿持久化（`useToolDraft`）与 `show_if` 显隐必须继续走 `visible_fields`，不得在前端复制条件逻辑。

### Phase 3 — 特例工具（进行中）

- **totp（已完成）**：转 live——输入密钥即出码；输出自带「剩余有效 N 秒」倒计时，页面以 5s 静默刷新（`useToolDraft.refresh`，不触发 running 态、失败保留上次结果）滚动倒计时，运行按钮移除。
- **password-gen / uuid-gen（已完成）**：转 live——`requiresInput === false` 的文件无关工具在默认值通过校验后**挂载即生成**，调整任意选项立即重新生成；运行按钮移除。
- live 谓词扩展：`areOptionsValid` 门控在前（必填缺失不自动跑、不误报），文件无关工具绕过「有内容才跑」判断。
- **network 4 工具**：维持 action，保留运行按钮（已完成结构确认）。

**验收**：各工具 `pnpm tauri dev` 冒烟；浏览器实测 totp 倒计时滚动、uuid-gen 挂载即生成。

### Phase 4 — 输出位置两档模式（已实现；用户定案为两档，替代原三档方案）

**模式定义（用户确认）**

1. **源文件位置（动态）**：结果保存到源文件所在文件夹，每次运行按当前文件动态解析（取全部输入的公共父目录）。
2. **指定文件夹（默认）**：现有行为——全局设置目录，缺省引擎默认目录。

**实现清单**

- `apps/web/src/lib/settings.ts`：`outputMode: 'folder' | 'source'`（持久化，默认 folder）。
- `apps/web/src/lib/files.ts`：`commonParentDir`——公共父目录解析（跨盘/裸根返回 null → 回退指定文件夹）。
- `apps/web/src/stores/engine.ts`：`applyJobDefaults` 按模式解析 `output.dir`——source 仅桌面生效（浏览器无文件系统，保持下载流），解析失败回退 folder。重跑队列（resubmit）同样生效。
- `apps/desktop/src/lib.rs`：新命令 `request_output_dir_grant(dir, title, message, confirm, cancel)`——已授权直接 true；否则**原生确认对话框**（文案由前端按 locale 传入）→ `grant_write_dir`，拒绝返回 false。授权手势符合 `access.rs` 威胁模型（WebView 不能自授予权限）。
- `apps/web/src/pages/ToolPage.tsx`：运行面板新增输出位置二选一 chips（仅桌面 + 文件工具）；source 模式下目录行显示动态提示；`onRun` 提交前对目标目录做授权请求，拒绝则 toast 并回退 folder——不静默失败。
- `apps/web/src/pages/SettingsPage.tsx`：输出设置新增默认模式选择（仅桌面）。
- 引擎与 catalog **零改动**（`stage_artifact` 的 `output_dir: Option<String>` 已覆盖两档语义）。

**浏览器 / 桌面差异（用户要求）**

- 桌面：两档可选；source 档首次写入新目录弹原生确认，授权会话内有效（跨会话持久性待定，见开放问题）。
- 浏览器：模式切换整体隐藏（文件工具与设置页均不出现），行为保持现状——产物留在内存/临时区，走浏览器下载。已实测确认隐藏。

**验收**

- `pnpm check` 全绿（含桌面 crate 编译与 clippy）。
- 浏览器模式实测：文件工具页与设置页均不出现模式切换。
- 桌面端冒烟（需 `pnpm tauri dev`）：source 档首次运行弹授权框→允许→产物落在源文件夹；拒绝→回退指定文件夹并 toast。

**风险**：iCloud/OneDrive 等同步盘目录写入会触发同步——文档标注，第一期不做阻断。

### Phase 5（可选）— 硬编码自由页收编

前四相稳定后，评估把 `ToolPage.tsx:323-337` 的三个 id 分支（color-convert / password-strength / invoice-organize）迁为 schema 声明的特化 layout，消除 id 硬编码。**本期不做。**

## 5. 总体验收

- `pnpm check`（version + lint + typecheck + rust fmt/clippy/test）。
- `pnpm test:tools` 金样 222 PASS / 0 DIFF 保持。
- 三平台 `pnpm tauri dev` 手动冒烟（live 工具、action 工具、输出三档、授权拒绝路径）。
- 所有新用户可见文案进 `en.ts` + `zh-CN.ts`，不硬编码。
- 新控件边界用 `--ui-control-line`，装饰用 `--ui-line`（AGENTS.md 规范）。

## 6. 开放问题

1. ~~aes / rsa / bcrypt 归 live 还是 action~~（已定：保持 action；totp/生成器已转 live 并落地）
2. 源目录写授权是否跨会话持久（记住已确认目录）还是每次会话重新确认——当前实现为会话内有效。
3. ~~「仅临时保留」的保留期~~（两档定案后该项取消；临时区仍作为内部机制按全局清理策略运作）。
4. hero 输入是否带行号（编辑器形态）——建议第一期不带，保持轻量。

## 附录 A — 工具分档清单

| 档 | 数量 | 工具 |
| --- | --- | --- |
| live（纯本地变换） | ~40 | crypto：hash、hmac、base64、radix、hex、url-codec、unicode-escape、jwt、x509、base64-file；developer：json-format、xml-format、xml-json、yaml-json、regex-test、binary-codec、case-convert、robots-txt；network：user-agent、ipv4-convert、ipv4-subnet、ipv6-convert、spf-record、dmarc-record、url-inspect、port-reference；time：timestamp、date-diff、date-math、workdays、timezone-board、duration、cron、date-format、relative-time；finance：amount-convert |
| 特例（定制交互） | 4 | totp（倒计时自动刷新）、password-gen、uuid-gen（生成即得）；password-strength、color-convert（已是自定义页，Phase 5 收编） |
| action（保留运行按钮） | 4~7 | dns-lookup、ping-check、tcp-check、ip-lookup（`networkAccess`）；system-network；待定：aes、rsa、bcrypt |
| 输出三档适用 | ~50 | 非 text 布局且 `requiresInput ≠ false` 的文件工具（standard / splitter / organizer / image-grid / metadata） |
