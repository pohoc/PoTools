# 实现差距、技术风险与整改登记

> 静态审查基线：`88acacba375f25a6f3980a1faacc03cf5b4cebb9`，2026-10-13。本表为任务账本，列举有代码依据的风险，不等于已经进行漏洞利用、完整 Tauri 动态测试或逐工具用户测试。
>
> **整改进度**：阶段 A（SEC-01 ~ SEC-05）已在 `77b3c2e` 之后的工作副本修复并附自动化负面测试，详见各行「已达成」与 [引擎/安全规范 §2、§6](../standards/ENGINE_SECURITY.md)。阶段 C（QA-01、CAT-01、REL-01、WIN-01）同批整改，验证记录见 [§4](#4-阶段-c-验证记录2026-10-13)，其中金样 CI 关卡与真实发布演练仍待线上观测。其余行仍为未修复。标记为「已整改」只表示代码与单测到位，不表示打包应用已实测。

## 0. 状态说明

- **代码确认**：可在源代码中指出具体执行路径或配置缺口；不表示危害在所有系统上复现。
- **待实测**：结论涉及 CSP、平台差异、内存/取消竞态、复杂文件或具体使用体验，需要实测后确认。
- **目标验收**：整改 PR 应达到的性质，尚未实现。
- **严重性**：P0 为存在明显越权或破坏性边界的优先阻断，P1 为功能一致性、质量与高影响逻辑，P2 为治理/体验与局部修复。

## 1. 优先问题清单

| ID | 级别 | 状态 | 位置 | 问题 / 影响 | 目标验收 |
| --- | --- | --- | --- | --- | --- |
| SEC-01 | P0 | 已整改 2026-10-13（自动化负面测试通过，打包版待实测） | `apps/desktop/src/lib.rs` 发票命令体、`services/invoice/` | `invoice_scan_list` / `invoice_read_candidate` / `invoice_archive` 缺少 `PathGrants` 源/目标范围检查。拥有 WebView IPC 能力的脚本可能枚举或读取未选取路径、执行非授权归档 | 已达成：命令体先 `require_source_dir` / `require_source_file` / `require_destination_dir`；`invoice_undo` 由引擎复核归档目录写授权。用例见 `invoice_tests::scanning_an_unauthorized_source_directory_is_refused`、`reading_an_unauthorized_candidate_returns_no_bytes`、`archiving_without_source_or_target_grants_writes_nothing`、`undo_is_refused_once_the_archive_directory_grant_is_gone` |
| SEC-02 | P0 | 已整改 2026-10-13（批准记录改由 Rust 持久化） | `apps/desktop/src/lib.rs` 的 `set_output_dir` / `set_temp_dir` / `temp_clean`、`access.rs` | 自由路径进入授权或清理，不等同于可信 OS 手势；清理根目录由调用者提供 | 已达成：`set_*_dir` 只接受 `directory-approvals.json` 中由原生对话框或 `approve_directory` 确认过的目录（输出=只写、临时=仅 `jobs/`+`inbox/`），`temp_clean` 受 `require_app_temp_root` 约束。残留：该 JSON 未加密、无防篡改，属信任锚点缺口，需要单独设计（如系统钥匙串或签名配置） |
| SEC-03 | P1 | 已整改 2026-10-13 | `apps/desktop/src/lib.rs` 的 `browse_directories` / `services/filesystem.rs` | 未经用户目录授权即可枚举给定路径，失败时还可回退父目录，涉及元数据泄露面 | 已达成：`resolve_browsable` 限定在已授权子树（Rust 自种子的主目录/文稿/下载/桌面 + 用户选取目录）；不可读返回 `unreadable` 且不再回退父目录，`parent` 越过授权根即截断；同级前缀目录与符号链接逃逸有断言 |
| SEC-04 | P1 | 已整改 2026-10-13 | `apps/desktop/src/lib.rs` 的 `temp_usage` / `services/temp.rs` | 自由 root 参数用于 `jobs/inbox` 用量统计，可能探测其他目录元信息 | 已达成：仅本进程 grant 过的临时根可统计；用例 `secure_paths_tests::temp_usage_is_confined_to_the_app_temp_root` |
| SEC-05 | P2 | 已加固 2026-10-13（确认语义仍待 UI 实测） | `invoice_undo` / `services/invoice/undo.rs` | 通过随机 archive ID 查内存记录，已有路径和 SHA-256 校验，仍需检查谁能要求撤销与用户确认 | 已达成部分：撤销前复核归档目录仍具写授权，无效 ID / 未知根 / 无授权均拒绝且文件保留（`undo_is_refused_once_the_archive_directory_grant_is_gone`）；随机 ID + 哈希防替换保护保持不变 |
| SEC-06 | **P0** | 已整改 2026-10-13（评审发现，含今日文档错误声明） | `apps/desktop/src/access.rs` `can_write` | `can_write()` 第一条分支就是 `can_read()`，于是 `grant_file` 授予的每个文件都可写：`system_font_candidates` 枚举的全部字体（含用户可写的 `~/Library/Fonts`、`~/.fonts`）与 `pick_files` 选中的每个输入文件，都能被 `write_file_bytes` 原地覆盖 | 已达成：文件授予拆分 `grant_file`（只读）/`grant_writable_file`（仅 `save_as` 的保存对话框结果），`can_write` 不再继承 `can_read`（目录子树仍读写）。用例 3 项：`a_picked_file_is_readable_but_never_writable`、`only_a_save_dialog_target_is_writable_and_stays_revealed`、`an_enumerated_font_path_is_not_a_write_target`。已确认 `write_file_bytes` 前端唯一调用方是 `nativeSaveAs`，收紧不破坏现有流程 |
| SEC-07 | P1 | 未完成（清单缺口，非漏洞证明） | `apps/desktop/src/lib.rs` 全部 35 个 `#[tauri::command]` | 引擎安全规范 §1/§2 要求逐条登记授权来源、读写/删除边界与直接 IPC 拒绝测试；实际只在 §2 登记 12 条。缺登记且无拒绝用例的包括：`engine_run_text_tool`、`engine_run_file_tool`、`write_file_bytes`、`stage_job_artifact_binary`、`open_path`、`print_file`、`save_as`、`pick_files`、`request_output_dir_grant`、`approve_directory`、`path_grants`（把已授权目录清单原样回吐）、`desktop_runtime_info`（回吐家目录）、`dns_lookup`/`ping_host`/`tcp_check_host`/`system_network_probe`（有超时，无目标范围/并发/预算声明，`validation.rs` 只做语法校验） | 待做：§2 表格补满 35 行；每个未覆盖入口一条「空 grant 集直接调用命令体即拒绝且无副作用」用例 |
| SEC-08 | P1 | 未完成（限额缺面） | `packages/engine/src/**`、`apps/web/src/lib/**` | 已强制：像素/边长上限按格式重复声明（image 120M、compress 80M、extract-images 120M+16k 边、preprocess 24M、OCR 20M）、OFD zip 三重预算、发票 2000 文件/100MB/2GB、字体 8×64MB+128MB、并发 1–4。**缺**：通用单文件字节上限（整文件仍会读进内存）、批次总量（merge/organize/images-to-pdf）、PDF 解压后对象预算（`decompressed_content()` 无界）、墙钟时限（`transport.ts` 注释自认未强制）、CPU/内存/句柄、`spawn_blocking`（lib.rs 头部注释自认待办）、adapter 产物累积无上限 | 待做：一张按 catalog 声明的限额表，在 `engine_run_file_tool` 与 Worker 入口统一消费；每项配超限用例 |
| SEC-09 | P2 | 未完成（脱敏不一致） | `apps/web/src/lib/log-buffer.ts:117-169`、`embedded-jobs.ts:552`、`FilePreviewDialog.tsx:74` | 只有崩溃卡片走 `redact`（`main.tsx:46-52`）；可复制的诊断日志面板原样导出 console 内容，含绝对路径、错误 stack，且 `error.details.file` 携带文件名/路径 | 待做：`exportLog` 复用同一 `redact`，日志面板标注「已脱敏」并保留可诊断性 |
| LICENSE-01 | P1 | 未完成 | `apps/web/public/fonts/NotoSansSC-Regular.ttf`（17M） | 该字体随包分发，但未出现在 `licenses:check` 清单、`docs/LICENSING.md` 或任何第三方声明里，也搜不到 OFL/SIL 文本（grep `Noto|OFL|SIL` 命中 0） | 待做：补 OFL 全文与署名条目，并纳入许可清单生成 |
| A11Y-01 | P1 | 已整改 2026-10-13（负责人选择：改 token 到真正 3:1） | `packages/ui/src/theme/tokens.css:6-13/75-77` | `--ui-control-line` 与装饰线 `--ui-line` 数值完全相同（浅 `220 226 234`、深 `55 65 80`），实测对四种承载背景仅 1.16–1.30:1（浅）/ 1.33–1.72:1（深），而 AGENTS.md 与工程规范 §2 都声称它是 WCAG 2.2 SC 1.4.11 的 3:1 档——该断言按当时值不成立 | 已达成：控件档改为保持原色相比例的浅 `133 136 141`(#85888D) / 深 `104 123 151`(#687B97)，最差面 `--ui-raised` 实测 3.16:1 / 3.17:1，其余面 3.16–4.13:1；新增 `scripts/check-theme-contrast.mjs`（`pnpm theme:check`，入 CI contracts 与 `pnpm check`）从 tokens.css 实测并额外要求装饰档不得高过控件档，防止两档重新塌成一色；变异验证：把控件值改回旧值即退出码 1。**未做**：视觉观感由负责人在浏览器里验收（本机不跑打包/构建类验证，也无 GUI 断言） |
| GATE-01 | P1 | 未完成（覆盖面与措辞） | `apps/web/scripts/run-browser-golden.mts:111-118`、`samples/` 金样登记表 | 金样是**引擎层** RPC 断言，实际覆盖 71/98 工具；21 个工具（含 `image-crop`、`invoice-merge`、`pdf-to-images`、`compress`）跳过产物 digest 比对只比结构；§5 七个代表工具里 `json-format`、`invoice-organize` **零条目**；没有任何 UI 级用例覆盖取消/过期/重试/键盘路径 | 待做：补 `json-format`/`invoice-organize` 金样与结构比对子集，另建浏览器 E2E 层做状态验收；QUALITY_GATES §1 已改写为如实覆盖面 |
| RUN-01 | P1 | 已整改 2026-10-13（打包版性能基线待实测） | `apps/web/src/lib/transport.ts` `resolveInput` / `embedded-jobs.ts` `submit` | 磁盘输入先进入 JS 字节数组，原生任务又传路径让 Rust 重新读，造成不必要 IPC/内存往返 | 已达成：`submit` 对「桌面 + 原生文件路由 + 全部输入已在磁盘」的请求以引用方式解析（`bytes` 为空、携带 `sizeBytes`），只有真正需要像素的步骤（`contentInsets`/`removeBlank`/字体/Markdown/OFD 预计算）或原生路由拒绝后的 Worker 回退才按需读取字节；任务摘要的 `inputBytes` 改用磁盘大小。未做：1/20/100 MB 级读字节数、峰值内存与耗时基线测量 |
| RUN-02 | P1 | 已整改 2026-10-13（取消粒度见规范 §4） | `embedded-jobs.ts` `cancel`/`publish`、`apps/desktop/src/jobs.rs`、`packages/engine/src/cancel.rs` | Worker 取消机制无法中断已提交的原生 Rust 文件任务；旧结果可能到达并发布成功 | 已达成：`JobCancels` 按 jobId 注册 `Arc<AtomicBool>`，`cancel_native_job` 置位；宿主在读取每个输入前、写出每个产物前检查，引擎在已插桩的进度循环（split、批量压缩、逐图压缩）协作退出；命令返回时注册自动失效，迟到的 cancel 无法标记后续同名任务。Runner 侧 `TERMINAL_STATES` 守卫 + store 两层同规则（事件与 `job.list` 回填）：已终态任务不能被不同终态覆盖。**评审补充**：Worker 成功后的 JS 暂存循环原本无取消检查，取消后仍会把产物写进输出目录，现已加逐产物 `stateOf()==='cancelled'` 停止并补 `a_cancelled_native_job_writes_no_artifacts`；引擎内部检查点仍只有 3 处（见 [SEC-08](#1-优先问题清单)） |
| RUN-03 | P1 | 已整改 2026-10-13（单一事实源，双向对账测试就位） | `transport-shared.ts` `RUST_NATIVE_FILE_TOOLS` / `packages/engine/src/tools/capabilities.rs` | 执行路由与能力列表两处维护，目录有实现不保证走理想宿主 | 已达成：路由决策只存在于 Rust `NATIVE_FILE_TOOLS` + `route_of()`（`native-file`/`adapter`/`engine`/`unrouted`），经 `coreHostRoutes` 随 catalog 注入 `RUST_NATIVE_FILE_TOOLS`（`installToolCatalog` 在清单为空时直接报错，不静默退化）；TS 侧手写副本已删除，故不存在可漂移的第二份清单。新增 Rust 用例 `native_routes_are_catalog_tools_the_engine_handles`、`every_catalog_tool_resolves_to_a_route`（98/98 可路由，`unrouted` 为 0）。迁移过程中该对账实际抓到 `compress` 一处既存偏差，已按当前真实行为登记为 `engine` |
| RUN-04 | P2 | 已整改 2026-10-13 | `embedded-jobs.ts` unsupported 分支 | 发布失败快照后立即 `jobs.delete`，列表刷新可能丢失失败记录 | 已达成：不再删除，失败记录保留到用户显式清理（`clear()` 只清理终态任务） |
| NET-01 | P1 | 配置已修正 2026-10-13（打包版实测仍待做） | `tauri.conf.json` CSP / `textToolRuntimeData` | `ip-lookup` 浏览器请求外部 API 与桌面 CSP `connect-src` 不一致 | 已达成：`connect-src` 增列 `https://ip.bt.cn`（唯一由 WebView 发起的外联），并在 `embedded-jobs.ts` 注明该条目是承重的——缺失时 fetch 只 reject 成 `status:'network'`，不会报错。引擎无 HTTP 客户端，引入依赖不在本轮范围，故未改为原生桥。残留：必须在**打包版**里查一次真实 IP 才等于验收 |
| QA-01 | P1 | 已整改 2026-10-13（单测/catalog 已入门禁；金样 CI 关卡待观测转正） | 根 `package.json` / `scripts/run-unit-tests.mjs` / `.github/workflows/ci.yml` | `pnpm check`、CI 未包含 `test:unit` / `test:tools`；`node --test` 直接跑 `.ts` 不能覆盖声明支持的全部 Node 版本 | 已达成：`test:unit` 改为 `node scripts/run-unit-tests.mjs`（探测式选择 TS 剥离方式，Node 20 给出可执行诊断而非崩溃），`catalog:check` 新增；两者进入 `pnpm check` 与 CI `contracts` job（必需步骤）。`test:tools` 保持**不在** `pnpm check`（需 wasm-bindgen + Chromium + 约 4 分钟，且金样按主机字体做字节比较），改由 CI `golden` job 跑，初期 `continue-on-error: true`。残留：Node 20.19 仍无法跑 `.ts` 单测（只能报错），`engines.node` 未收紧；macOS runner 上的金样结果未经真实 Actions 运行验证 |
| REL-01 | P1 | 已整改 2026-10-13（离线演练通过；未推 tag，未触发任何发布） | `.github/workflows/release.yml` / `scripts/release-version.mjs` / `scripts/collect-release-artifacts.mjs` | 发布资源重命名、Updater 清单硬编码 `0.1.0`，版本升级将找不到预期资源 | 已达成：`stamp` job 由 tag 推导版本（`scripts/release-version.mjs` 校验 tag 形状并与 root `package.json` 比对，不一致即失败），`publish` 的 12 个产物改名与三份 updater 清单 URL 全部用 `${VERSION}` 拼接，缺文件时打印实际目录内容；`prepare` 增加 `pnpm version:check`；Win7 `说明.txt` 不再写死版本。残留：真实 tag 的端到端安装/自升级未验证（需在有仓库权限的环境用演练 tag 跑一次） |
| UX-01 | P2 | 已整改 2026-10-13 | `useToolDraft.ts` live 效应 | 当输入从合法变为不合法时直接返回，可能继续展示上次可复制结果 | 已达成：结果面板新增过期标识——参数不可计算时保留结果并显示 `result.staleInput`（`role="status"`，不只靠颜色），生成器在参数变化时刻意保留当前值并显示 `result.staleGenerator`，只有显式运行才替换；节奏改由 catalog `experience.execution` 决定（live ≈120ms、debounced ≈350ms、manual 显示运行按钮），`ToolPage` 的实时提示/按钮分支同源。GUI 双主题与读屏实测仍未做 |
| UX-02 | P2 | 未完成（RFC-0001 阶段 2-3） | `ToolPage.tsx` 主编辑器分支、`ResultPanel.tsx` 呈现分支 | 七类交互模板尚未落地：页面仍按 `layout` + 字段形态分配通用工作台，结果呈现部分依赖 `password-gen.txt` / `color-values.txt` 这类产物文件名 | 待做：`instant-transform`/`structured-inspector`/`calculator`/`generator`/`visual-editor`/`batch-processor`/`guided-workflow` 七套工作台与类型化 structured result renderer，先迁移七个代表工具（`json-format`、`jwt`、`cron`、`password-gen`、`image-crop`、`merge`、`invoice-organize`），每项需 UI 录屏、键盘路径与 Web/Tauri 能力差异说明。`experience` 契约与分类已在 catalog 就位 |
| CAT-01 | P2 | 已整改 2026-10-13（变异测试证明检查会失败） | `packages/core/tests/catalog_contract.rs` / `scripts/check-catalog-contract.mjs` | 能力列表已有对账，但字段 key 重复、默认值类型、双语翻译、schema 交叉引用没有集中强制检查的证据 | 已达成：schema 检查放在 catalog 实际解析侧（Rust，9 个用例：跨 14 个 catalog 的 id 唯一、每工具字段 key 唯一、`default` 与声明 `type` 一致、select 选项值为稳定 ASCII id 且默认值在选项内、数值范围、`showIf.field` 与被引字段取值域交叉校验、`applies` 引用真实 key、preset 类型、磁盘 catalog 文件与 `CATALOG_SOURCES` 双向一致（`every_catalog_file_on_disk_is_embedded_and_identical`：评审发现原来的 `catalog_blob_is_the_union_of_the_domain_files` 是在比 `all_tools()` 与它自己的来源常量，永远不可能失败，已重写并用「塞一个未嵌入的 JSON 文件」证明会红）；另加 `showIf.in` 不得为空数组）；l10n 与嵌入对账在 `scripts/check-catalog-contract.mjs`（1227 处 `*Key` 引用两表齐备、两表键集相同；评审指出数组形态的 `*Keys`/`*KeyList` 元素未被扫描，已修并用注入 `placeholderKeyList:['totally.missing.keyA']` 证明会红——当前 catalog 里这类属性 0 处，属预防性收紧，且 `id-photo.json` 这类「仅选项数据」文件不在扫描范围内），诊断都带文件/工具/字段路径。已注册为 `pnpm catalog:check`，并进入 `pnpm check` 与 CI `contracts` job。残留：同一 workflow 内 `order` 重复（`conversion` 的 `images-to-pdf` 与 `pdf-to-word` 同为 120）未设为硬门禁，涉及 UI 排序需另行确认 |
| WIN-01 | P2 | 已整改 2026-10-13（真实 HTTP 负面测试通过；Windows 平台实测待打包） | `apps/legacy-win7/static-server.cjs`（从 `main.js` 拆出）/ `apps/legacy-win7/tests/static-server.test.mjs` | 使用 `file.startsWith(dist)` 判断静态目录包含关系，并直接对 URL 调用 `decodeURIComponent`，需防同前缀路径及非法编码异常 | 已达成：`resolveStaticFile` 用 `path.relative` 判定目录内（同前缀兄弟目录 `dist-other`、`//etc/passwd` 绝对形式、`%2e%2e` 编码穿越均 403），畸形百分号编码与 `%00` 回 400 而非抛异常，正常请求行为等价（index、资源 MIME、SPA 回退）；7 个用例进入 `pnpm test:unit`。`build.files` 已加入 `static-server.cjs`。残留：Windows 上 `\` 分隔符与大小写不敏感路径的真实 Electron 打包验证未做（本机仅 macOS；用例已对两种行为断言不泄露内容） |
| GOV-01 | P2 | 维护性建议 | `AGENTS.md` / 大型服务和页面 | 本次规范建议将新代码控制在约 500 行内；**原始 `AGENTS.md` 并没有该硬性约束**。部分页面/服务超过建议值，专项逻辑存在耦合风险 | 按职责分层拆模块；保持行为等价，单项 PR 有回归证据 |

> 关注安全：`SEC-01` / `SEC-02` 的前置条件是能够调用桌面 WebView IPC；不能在未证明的情况下宣传为远程零点击漏洞。所有问题均保留为“未修复”，直至对应代码 PR 和可复现测试合入。

## 2. 优先复现与验收建议

### SEC-01 / SEC-02：路径与数据权限

- 从测试 WebView 以无 grant 的绝对路径调用 `invoice_scan_list`、`invoice_read_candidate`、`browse_directories`，要求权限拒绝且无目录/文件数据泄露。
- 传入任意 root 调用 `temp_usage`，需验证不能获取未经授权的用量元信息。
- `invoice_undo` 应测试合法记录、非法 ID、文件被改动/移动与用户取消；已有随机 ID+哈希校验不能被误称为任意路径删除漏洞。
- 以未获授权的来源和目标路径调用 `invoice_archive`，确保没有任何源内容被拷贝到目标。
- 提供可控的任意根目录（内含 `jobs` 和 `inbox`）请求 `temp_clean`，确保服务拒绝删除；权限拒绝无副作用。
- 目录替换、符号链接、绝对/相对路径、Unicode 与 Windows 路径在访问时重复验证。

### RUN-01 / RUN-02 / RUN-03：性能与任务一致性

- 原生 PDF 合并/图片缩放从磁盘路径调用，仪器记录 JS ↔ IPC 读取字节总量、主线程峰值内存及总处理时间；不要仅用“看起来更快”验收。
- 任务执行途中取消（并行 1 和 4、首个/最后一个文件、写入前），确保 Rust 中断或明确不可中断边界，前端最终态一致且产物不偷偷复制。
- 98 工具按主宿主生成路由清单，标注 `Native / Worker / adapter / Unsupported`，实际启动校验全量对账。

### NET-01 / QA-01 / REL-01：交付链

- 使用**打包后的** Tauri 执行 IP 查询，验证 CSP 和出站请求行为、离线/超时错误。
- 用 root engines 声明的最低 Node 版本测试 `pnpm test:unit`，并将金样/单测并入 Actions；报告命令与测试数。
- 在测试 tag 上验证非 `0.1.0` 的产物名、签名清单和自动更新端点，并安装/启动一次。

## 3. 迭代划分

| 阶段 | 内容 | 完成定义 |
| --- | --- | --- |
| A：安全阻断 | SEC-01、SEC-02、SEC-03、SEC-04；并复核 SEC-05 | **2026-10-13 代码与单测完成**：`pnpm rust:test` 下 engine 123 项、desktop 32 项通过，权限负面用例覆盖未授权扫描/读取/归档/清理/浏览越界；仍未做打包版与 WebView 层实测 |
| B：引擎运行契约 | RUN-01/02/03/04、NET-01 | **2026-10-13 代码完成**：Native 取消 token + 终态守卫、按需读字节、路由清单单一化、失败快照保留、CSP 外联白名单；`pnpm test:tools` 改动后 222 PASS / 0 CRASH。大文件字节/内存/耗时基线与打包版实测仍待做，见 [§5](#5-阶段-abd-验证记录2026-10-13) |
| C：质量与发布 | QA-01、CAT-01、REL-01、WIN-01 | **2026-10-13 代码与门禁完成**：`catalog:check` + `test:unit` 进入 `pnpm check` 与 CI `contracts`（必需），金样进入 CI `golden`（先 `continue-on-error`）；发布产物名改由 tag 推导并完成 `v0.2.0` 离线改名/清单演练；Win7 静态目录边界有真实 HTTP 负面用例。仍未做：真实 Actions 运行结果、真实 tag 端到端安装与自升级、Windows 打包版实测。详见 [§4](#4-阶段-c-验证记录2026-10-13) |
| D：工具交互 | UX-01、GOV-01 + [98 工具矩阵](TOOL_UX_MATRIX.md) | **2026-10-13 完成 RFC-0001 阶段 1**：`experience`（七类模型 + 执行节奏）成为 catalog 必填字段并按矩阵登记 98 项，节奏/过期结果/运行按钮改由声明驱动，并有机械校验测试。阶段 2-3（七套工作台模板、类型化结果渲染器、按文件名推断呈现的替换）未实施，登记为 [UX-02](#1-优先问题清单)；`GOV-01` 大文件拆分未开始。 |

每个整改 PR 应在本表添加：状态、负责人、Issue/PR、验证系统、测试命令、复现材料和最终结论。不推荐只改文本为「已完成」而无测试证据。

## 4. 阶段 C 验证记录（2026-10-13）

验证系统：macOS（darwin，本机）· Node v25.3.0 · Rust stable 1.98.1（Homebrew `/usr/local/bin/cargo`）· pnpm 12 · 基线 `77b3c2e` 之后的工作副本。以下命令都实际执行过；未执行的写在「未验证」里，不记作通过。

| 项 | 命令 | 真实结果 |
| --- | --- | --- |
| CAT-01 schema | `cargo test --tests`（在 `packages/core`） | 评审后复测：`test result: ok. 10 passed; 0 failed`（`tests/catalog_contract.rs`）+ lib 15 项。**原记录写的是 9 项，是在编数量** |
| CAT-01 有效性 | 逐个篡改 `packages/core/catalog/crypto.json` 后跑 `cargo test --test catalog_contract` | 5 类篡改全部被捕获并给出文件/工具/字段级诊断：重复 id、`default` 不在 select 选项内、悬空 `showIf.field`、中文选项值、布尔默认写成字符串；篡改后已还原（`git status` 干净） |
| CAT-01 l10n | `pnpm catalog:check` | `[catalog:check] OK — 14 catalog file(s), 98 tool(s), 1227 key reference(s) (1064 distinct) resolved in both locales`；两表键数随文案增加（现各 1797）；缺失键 / 未嵌入 catalog 的注入用例分别退出码 1 并报出位置 |
| QA-01 单测 | `pnpm test:unit` | `[unit] Node 25.3.0 — type stripping is available without flags; 4 test file(s)`，`tests 38 / pass 38 / fail 0`（3 个 `.ts` + 1 个 `.mjs`） |
| QA-01 兼容性 | 注入 probe 结果调用 `selectRuntimeSetting()` / `explainUnsupported()` | 三种分支正确：默认可用、需 `NODE_OPTIONS=--experimental-strip-types`、Node 20.19 报出 `ERR_UNKNOWN_FILE_EXTENSION` 并给出可执行建议。本机只有 Node 25.3.0（无 nvm/mise/其它 node 前缀），因此**未在真实 20.19/22.12 上跑过** |
| QA-01 金样 | `pnpm test:tools`（2026-10-13 10:10–10:11，前置 `pnpm wasm:build`） | `browser golden: 222 PASS, 0 FALLBACK, 0 DIFF, 0 CRASH, 4 KNOWN / 226 entries`，退出码 0；4 条 KNOWN 为既有引擎质量差异说明。同日 09:54 另一次运行失败于 wasm-bindgen 缺失与 `browser failed to launch`，属环境抖动 |
| REL-01 版本推导 | `node scripts/release-version.mjs v0.2.0`（模拟 0.2.0 树）/ `v0.3.0` / `release-2026-10-13` | 一致 tag 输出 `0.2.0` 退出 0；漂移与非法 tag 各退出 1 并给出 `pnpm version:sync` 或正确 tag 形式的修复指引 |
| REL-01 改名/清单 | 从 `release.yml` 抽出 `publish` 的 `run` 块 → `bash -n` → 在 `VERSION=0.2.0`、伪造 12 个产物、stub `gh` 的沙箱里执行 | `bash -n` 通过；改名得到 12 个 `PoTools_0.2.0-<stamp>…` 产物；三份 `latest*.json` 的 URL 全为 `…/download/v0.2.0/PoTools_0.2.0-<stamp>_…`，`version` 字段 `0.2.0`；缺文件分支打印 `缺少预期产物 …` 与 `bundles/` 列表并退出 1 |
| WIN-01 | `node --test apps/legacy-win7/tests/static-server.test.mjs` | `tests 7 / pass 7 / fail 0`：`/../dist-other/secret.txt`、`%2e%2e`、`//etc/passwd`、`/assets/../../…` 为 403；`%zz`、`%`、`%00` 为受控 400 且服务存活；index/资源 MIME/SPA 回退等价 |
| 门禁 | `pnpm lint`、`pnpm catalog:check`、`pnpm test:unit`、`pnpm rust:fmt`、`pnpm rust:clippy`、`pnpm rust:test`、`pnpm rust:check:wasm` | 结果与归属见 [QUALITY_GATES §1](../standards/QUALITY_GATES.md)；阶段 A/B 合入后复测：`packages/core`、`packages/engine`、`apps/desktop` 的 fmt/clippy/test 全部通过（2026-10-13 12:3x） |

未验证（不得记作通过）：

- GitHub Actions 上这些步骤的真实运行记录（本次只做静态编排 + 本地等价执行）；`golden` job 需在 macos-latest 上连续两轮无环境性失败才转必需。
- 真实 tag 的端到端发版：产物下载、安装、启动、自动升级端点消费 `latest.json`。
- Windows 上的 Win7 壳实测（`\` 分隔符、大小写不敏感路径、`electron-builder` 打包后的 `static-server.cjs` 是否随包）；本机仅 macOS。
- Node 20.19 / 22.12 真实二进制下的 `pnpm test:unit` 行为。
- catalog `order` 同 workflow 重复（`conversion` 的 `images-to-pdf` 与 `pdf-to-word` 同为 120）未设为门禁，需 UI 侧确认排序语义后再决定。

## 5. 阶段 A/B/D 验证记录（2026-10-13）

验证系统：macOS x86_64（darwin 24.6）· Node 25.3.0 · Rust stable 1.98.1 · pnpm 12 · 基线 `77b3c2e` 之后的工作副本。Rust 相关命令需要 PATH 上是 **rustup 的 cargo**（`~/.cargo/bin`）；本机默认 `/usr/local/bin/cargo`（Homebrew）没有安装 `wasm32-unknown-unknown` 的 std，`pnpm wasm:build` 与 `pnpm rust:check:wasm` 会在那上面失败——这是主机工具链问题，已在此记录以免下一个人重新踩。以下均为实际执行结果；未执行的写进「未验证」。

| 项 | 命令 | 真实结果 |
| --- | --- | --- |
| SEC 门禁 | `pnpm rust:test`（`apps/desktop`） | `test result: ok. 36 passed; 0 failed`；其中未授权负面用例 `scanning_an_unauthorized_source_directory_is_refused`、`reading_an_unauthorized_candidate_returns_no_bytes`、`archiving_without_source_or_target_grants_writes_nothing`、`undo_is_refused_once_the_archive_directory_grant_is_gone`、`temp_usage_is_confined_to_the_app_temp_root`、`temp_clean_refuses_a_root_the_app_never_granted`、`a_configured_directory_grants_nothing_until_it_is_approved`、`browsing_is_limited_to_the_authorized_subtrees`、`a_missing_subdirectory_does_not_become_its_parent`、`the_derived_default_directories_need_no_approval` |
| SEC 授权层 | `cargo test`（`apps/desktop`，`access::tests`） | 批准白名单持久化与重启恢复、写授权永不成为读授权、同级前缀目录、`..` 逃逸、符号链接、仅 `jobs/`+`inbox/` 的临时根授权等 15 项通过 |
| 浏览边界 | `cargo test --lib`（`packages/engine`，`path_guard_tests`） | 未授权目录拒绝、`-backup` 同级前缀拒绝、不可读目录返回 `unreadable` 且不列父目录、`parent` 在授权根处截断、符号链接逃逸拒绝 |
| RUN-02 取消 | `cargo test`（`apps/desktop`，`jobs::tests`） | 3 项通过：活任务置位、任务结束后迟到取消无效、任务之间互不影响 |
| RUN-03 路由 | `node --input-type=module` 直接调用重建后的 `coreHostRoutes` | `routed tools: 98 \| native-file: 25 \| adapter: 4 \| engine: 69 \| unrouted: 0`；`merge=native-file`、`compress=engine`、`pdf-to-images=adapter` |
| 任务链路回归（**仅引擎层 RPC，覆盖 71/98 工具，21 工具跳过 digest**，见 GATE-01） | `pnpm test:tools`（阶段 B 之后与阶段 D catalog 迁移之后各一次） | 两次均 `browser golden: 222 PASS, 0 FALLBACK, 0 DIFF, 0 CRASH, 4 KNOWN / 226 entries`，退出码 0；4 条 KNOWN 为既有引擎质量差异 |
| experience 契约 | `cargo test --test catalog_contract`（`packages/core`） | `test result: ok. 10 passed`，含新增 `every_tool_declares_a_consistent_experience_model`（七类全部被使用、`live` 不落在外联/多文件/生成器、总数 = 98） |
| 契约数据分布 | 迁移脚本产出后按 catalog 统计 | kinds：visual-editor 21、batch-processor 20、instant-transform 18、structured-inspector 15、calculator 12、guided-workflow 9、generator 3；execution：manual 59、live 21、debounced 18（违规 0） |
| i18n | `pnpm catalog:check` | `OK — 14 catalog file(s), 98 tool(s), 1227 key reference(s) (1064 distinct) resolved in both locales`；zh-CN 与 en 各 1796 键（新增 `result.staleInput`、`result.staleGenerator`、`settings.approve.*`、`picker.unreadableHint`） |
| 门禁 | `pnpm lint`、`pnpm --filter @potools/web typecheck`、`pnpm rust:fmt`、`pnpm rust:clippy --all-targets -D warnings`、`pnpm test:unit` | 分别 0 error、tsc 无输出、3 crate 格式一致、clippy 无告警、`tests 38 / pass 38 / fail 0` |

未验证（不得记作通过）：

- **打包后的 Tauri 应用**：`pnpm tauri dev` 与发行包未在本轮运行，因此授权对话框的实际弹出、拖放手势授予、`directory-approvals.json` 的真实写入位置、CSP 下 IP 查询是否成功、取消按钮的实际中断时机都仍属 **待实测**；本轮证明的是命令体/服务层行为与自动化用例。
- WebView 层的真实注入测试（用脚本直接 `invoke` 特权命令）没有做，负面用例是在命令体入口层执行的（与 `#[tauri::command]` 包装仅差 `State` 提取器）。
- `pnpm check` 的完整串行执行未跑到底（`rust:check:wasm` 需 rustup cargo）；各分项均已单独通过。
- 阶段 D 的 GUI 侧：过期结果提示、生成器保持值、窄屏/浅色深色/读屏表现均未经浏览器实测或录屏。
- 大文件（1/20/100/500 MB）在引用式解析下的字节数、峰值内存与耗时基线尚未测量（RUN-01 的验收条件之一）。

## 6. 全面评审后的补充整改（2026-10-13）

对上面三个阶段做了一遍独立评审（含两个只读审查子任务），发现并修掉以下问题；每条都带可复现证据，不是文案调整。

| 发现 | 影响 | 处理 |
| --- | --- | --- |
| 取消终态只在 job runner 一层守 | 原生命令无法中途丢弃 invoke，取消后的迟到 `succeeded` 若经 `transport.onEvent` 或 watchdog `job.list` 回填，`apps/web/src/stores/jobs.ts` 会无条件覆盖，并把「取消」显示成「成功」，还会触发 `autoOpen` 打开产物 | store 的事件与 refresh 两条路径都加同一条终态规则（同状态允许重发，便于暂存改写产物路径）。已确认重试走 `resubmit` → 新 jobId，因此守卫不会把失败任务卡死 |
| `password-gen`/`uuid-gen` 迁移后丢失首次样例 | 规范 §2 允许生成器首次自动给一个样例；映射成 `manual` 后 `autoRun=false`，打开页面是空结果，只有手点。审查建议改 `debounced`，但那会让 `ToolPage.liveText=true` 从而**消失重新生成按钮**，与「手动再生成」要求相反 | 采纳「generator + manual」而把首次样例作为 manual 的唯一例外：`autoRun = execution !== 'manual' \|\| kind === 'generator'`，展示后进入 `held`。运行按钮保留，即明确的「重新生成」入口 |
| TOTP 会被生成器保持规则冻住输入 | totp 是 generator 但代码是 secret 与时间的函数；若一并 held，改密钥后仍显示旧码，且 5 秒静默刷新会在「请按再次运行」提示下悄悄改值 | 保持规则只作用于 `generator + manual`；totp 声明为 `debounced`，继续随输入重算并周期刷新 |
| 手动文本工具的结果永不标过期 | aes/rsa/bcrypt/ip-lookup 等运行一次后改参数，旧结果仍可直接复制且无提示，违反 §2「清空或标识」 | 记录产生该结果的参数指纹，参数变化即置 `stale:'changed'` 并在结果面板以 `role="status"` 文案说明；文件类产物属已完成任务的历史输出，不做同等标注（已在规范边界内说明） |
| `interaction` 成为矛盾的死字段 | 全仓无读者，但 39 项仍写 `live`，与 `experience.execution` 冲突，正是 RUN-03 刚消除的「第二个事实源」形态 | 从 catalog、Rust `ToolDescriptor`、TS 镜像与枚举一并删除；矩阵与 RFC 记录该偏离及理由 |
| 体验契约测试可被绕过 | 只校验 `live` 的外联/多文件；`debounced` + `networkAccess`（一键入就发外部请求）与非 `text` layout + 自动运行（走内存 `tool.run`，文件工具根本没有那条路径）都能通过 | 两条规则并入「任何自动运行」并新增「文件工具不得自动运行」；对 `ip-lookup` 做变异测试确认会失败并报出 `network.json > tool 'ip-lookup' > experience.execution` |

复验结果（同一台 macOS x86_64 / Node 25.3.0 / Rust 1.98.1，rustup cargo 在 PATH 上）：`packages/core` clippy `-D warnings` 干净、`catalog_contract` 10 项通过；`pnpm check` 除下述金样外全绿；`pnpm --filter @potools/web typecheck` 无输出；`pnpm catalog:check` 两表各 1797 键且 98 项引用齐备。金样与阶段 B/D 其余结论见 [§5](#5-阶段-abd-验证记录2026-10-13)。

仍未处理，且明确不是「已修」：七套工作台模板与类型化结果渲染器（UX-02）、`color-convert`/`password-strength` 这类「声明为 live 但走专用面板」的装饰性登记、`spf-record`/`dmarc-record` 的 `guided-workflow` 归类是否恰当、`catalog_contract.rs` 里写死的 98。

安全侧三项残留（本轮评审确认，非新漏洞，但需要按规范的「特权入口清单」逐条登记或整改）：

- `ping_host` / `tcp_check_host` / `dns_lookup` / `system_network_probe` 仍接受任意主机与端口，没有目标范围、并发或超时限额的显式声明（[引擎安全规范 §5](../standards/ENGINE_SECURITY.md) 要求逐条声明 host、数据类别与超时）。拥有 IPC 能力的脚本可把它们当内网探测原语用。
- `system_font_candidates` 会为系统字体目录与本用户可写的 `~/Library/Fonts`、`~/.fonts` 主动发放**只读**授权（原生代码嵌入 CJK 字体的需要）。它属于规范新增的「第四类来源：本进程自行枚举」，已在 [§1](../standards/ENGINE_SECURITY.md) 登记，但范围能否收窄（例如只授予实际被选中的那一个字体文件）尚未评估。
- `path_grants` 把当前已授权目录清单原样返回给调用方，`invoice_archive` 在**已授予来源目录内部**允许归档调用方自行指定且哈希匹配的文件（用户未勾选的那部分）。两者都不是跨边界逃逸，但都应在威胁模型里写明：授权边界是「目录」，不是「用户本次真正选中的那几个文件」。

以及 `pnpm check` 全链与打包版实测。

### 评审后按仓库拥有者决定落地的三项

| 项 | 决定 | 已做 |
| --- | --- | --- |
| Node 支持面 vs 门禁 | 保留 `^20.19.0` 支持，`test:unit` **移出** `pnpm check` | `package.json#check` 去掉 `pnpm test:unit`；CI `contracts` 仍强制单测；[QUALITY_GATES §1](../standards/QUALITY_GATES.md) 与 [ENGINEERING §3](../standards/ENGINEERING.md) 改为「否，CI 强制」，并写明若收紧 engines 到 ≥22.6 应放回 check |
| `AGENTS.md` 与实际不符 | 授权更新 | 命令表补 `test:unit`/`catalog:check`；`pnpm check` 组成重写；新增一段说明两个测试门禁为何故意留在 CI；删除「There is no separate unit-test runner configured」并改写 Testing Guidelines 首句 |
| Windows x86 承诺不一致 | CI 补 x86 构建 | `release.yml` 矩阵加 `windows-x86`（`--target i686-pc-windows-msvc`，bundles 走 `target/i686-pc-windows-msvc/.../nsis/*`），Rust target 改为按矩阵项 `rust-targets` 提供（原来的 `macos-latest && x86_64-apple-darwin || ''` 表达式装不上 i686），artifact 名改为 `bundles-<platform>-<arch>` 以免两个 windows 项互相覆盖（publish 用 `pattern: bundles-*` 不受影响），并在 `publish` 改名清单补 `_x86-setup.exe` 与 `.sig` 两行。两份 workflow 均通过 YAML 解析校验；真实发版仍需一次演练 tag 验证 |
