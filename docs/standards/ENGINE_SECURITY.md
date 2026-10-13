# 引擎、安全和宿主边界规范（Engine & Security Standard）

**状态**：应遵守的安全底线与待整改设计，非“当前代码全部安全”的声明。受限于静态审查，本文件不证明漏洞已被实际利用。

## 1. 信任边界

```text
不可信：WebView JS、Worker 消息、用户输入、options、runtimeData、
        FileRef.path、文件名、归档相对路径、网络响应、目录设置
                ↓ 验证、限额、授权
可信边界：Tauri Rust 命令入口及其后端 PathGrants / OS 手势记录
                ↓
特权操作：读、写、复制、删除、文件浏览、启动外部程序、网络探测
```

- **前端校验不是授权**：任何 `invoke()` 都应假定可被恶意注入脚本调用；“设置项已经在 UI 展示”不足以证明前端传入的路径是用户主动同意的。
- **权限来源**：后端系统对话框结果、可信 OS 拖放、经过认证的应用管理目录。设置更改不能直接把任意自由路径变成全局读写 grant。
- **第四类来源（受限、须逐条登记）**：由本进程自己枚举出的系统路径，例如 `system_font_candidates` 为嵌入 CJK 字体而授予 `/System/Library/Fonts`、`~/Library/Fonts`、`~/.fonts` 中候选字体文件的权限。它不来自 WebView 的字符串，因此可用；每新增一处都必须在此登记，并说明授予范围与为何无法改由对话框取得。
- **读授权绝不蕴含写授权**（SEC-06，2026-10-13 修复）：`PathGrants::can_write` 早期实现是「先问 `can_read`」，于是上条列出的每个字体文件、以及用户在 `pick_files` 里选中的**每一个待处理输入文件**，都同时成为 `write_file_bytes` 的可写目标——脚本可原地覆盖用户刚选的发票原件。现在文件授予分两种：`grant_file`（只读，用于字体枚举、选中输入、本进程写完后供「reveal」回读的文件）与 `grant_writable_file`（仅由原生保存对话框结果 `save_as` 授予）；选取/拖放的**目录**仍是子树读写。用例：`a_picked_file_is_readable_but_never_writable`、`only_a_save_dialog_target_is_writable_and_stays_revealed`、`an_enumerated_font_path_is_not_a_write_target`。

行为必须包含：身份和权限判断、目录范围限制、错误码一致性、符号链接校验、审计与单测。路径比较统一走引擎的 `filesystem::resolve_path`（对最近存在的祖先 canonicalize 后原样追加尾部），因此 `..`、符号链接与 macOS 的 `/var` → `/private/var` 变体都不能绕过前缀检查。请勿为了通过 UI 测试而添加任何 JS 可无条件授予读权的接口。

**授权与设置分离的取舍**：`directory-approvals.json` 由本进程写入应用配置目录，启动时重新生效，所以「设置里保存的目录」不必每次重启都重新确认；文件记录的是**用途**（输出写入 / 临时暂存），输出始终是只写、临时始终只覆盖 `jobs/`+`inbox/`。该文件本身不做加密与防篡改，属已知残留风险。

## 4. 任务运行安全

- 每个任务以 `jobId` 标识并支持 cancellation token。当前**实际粒度**（必须按此理解，不是「随时可中断」）：宿主在读取每个输入前、写出每个产物前检查一次标志（`apps/desktop/src/lib.rs` 的 `engine_run_file_tool` / `stage_native_artifacts`），引擎只在已插桩进度的 3 个循环里协作退出（`page_ops.rs`、`compress.rs` 两处）；merge、images-to-pdf、OFD、extract-images 与各转换工具在单个工具调用内部**没有**检查点，取消要等该调用返回后才生效。Worker 侧靠 `worker.terminate()` 中断（`embedded-engine.worker.ts` 里的 `cancelledJobs` 集合目前无人读取，属死码）。写出侧的三段守卫：原生暂存前检查、Worker 成功后的 JS 暂存循环逐产物检查（`embedded-jobs.ts` `stateOf(...) === 'cancelled'` 即停），以及 runner/store 两层终态守卫。测试：`a_cancelled_native_job_writes_no_artifacts` 断言取消后临时目录与输出目录都没有新文件。
- 实施分层限额：单文件大小、解压后对象/像素/页数、批次总数据量、运行时间、CPU/内存、文件句柄、并发。
- OCR/图像/PDF 处理大量不可信字节，失败和 panic 应转成结构化 `EngineError`；不能把堆栈和敏感内容直接放到用户可复制日志。
- 大文件避免在 JS 与 Rust 双侧重复保留字节；数据在 Worker 传输时使用 transferable，文件产物优先临时 staging 和受控复制。
- 文件名、相对路径、PDF/OFD/EPUB/ZIP 内条目必须避免目录穿越、绝对路径与链接逃逸；对解压炸弹和巨大对象启用预算。
- 对部分成功的操作返回已完成产物与失败项，不得将“取消”伪装成“成功”。

## 5. 网络、密钥、日志与隐私

- 网络访问单独声明目标 host、发送的数据类别、超时及错误状态；Web `fetch` 必须与 Tauri CSP 一致，Native 网络服务由明确的调用权限限制。
- 不将文档内容、密码、密钥、Token、TOTP secret 和私密路径加入遥测或持久日志；错误报告需要脱敏，但不能假定正则替换就是完全匿名化。
- 密码学工具区分“解析、编码、加密、签名、校验”，不得用“解码成功”暗示可信性。
- 对浏览器同源/Win7 Electron EOL 风险保持单独威胁模型；旧系统发行包不得宣传与受支持桌面宿主同等级别的系统安全。
- CSP、Tauri capability、自动更新密钥和签名应在 **最终打包应用** 中验证；CI 中仅编译通过不代表最终策略生效。

## 6. 权限回归测试最低集合

`Verified` 列指已有自动化用例（`pnpm rust:test`，macOS x86_64，Rust 1.98，2026-10-13）；未标注的仍需人工或打包版实测。

1. 未授予来源目录时，发票枚举和按绝对路径读取必须被拒绝；`browse_directories` 不能越过已授予的目录树或回退到未授权父目录。 — Verified：`invoice_tests::scanning_an_unauthorized_source_directory_is_refused`、`reading_an_unauthorized_candidate_returns_no_bytes`、`secure_paths_tests::browsing_is_limited_to_the_authorized_subtrees`、`a_missing_subdirectory_does_not_become_its_parent`、`filesystem::path_guard_tests::*`（同级前缀、符号链接、父级截断）。
2. 未授予目标目录时，发票归档、文件输出必须被拒绝；拒绝后原文件不变化。 — Verified：`invoice_tests::archiving_without_source_or_target_grants_writes_nothing`（断言目标目录仍为空、源文件字节不变）；`access::tests::an_enumerated_font_path_is_not_a_write_target`、`only_a_save_dialog_target_is_writable_and_stays_revealed`（读授权不蕴含写）。
3. 恶意 `../`、符号链接、目录替换、UNIX/Windows 根路径与 UNC 情况可预测地拒绝。 — 部分 Verified：`access::tests::traversal_cannot_escape_a_granted_directory`、`a_deleted_and_recreated_symlink_target_stays_out`、`invoice_relative_paths_reject_traversal_and_sanitize_windows_names`；目录替换与 UNC 仍需动态复现。
4. 临时清理永不访问应用根目录之外的 `jobs/inbox`，不可删除由攻击者自选根目录下的内容。 — Verified：`secure_paths_tests::temp_clean_refuses_a_root_the_app_never_granted`、`temp_usage_is_confined_to_the_app_temp_root`。
5. 非法 Job ID、嵌套文件名、极大文件、巨大解压对象、损坏 PDF 应有受控错误。 — 待补（阶段 B 与金样覆盖）。
6. Native 任务执行中取消后最终目录无新输出；迟到进度/结果不能覆盖取消态。 — Verified（写出边界与终态）：`secure_paths_tests::a_cancelled_native_job_writes_no_artifacts`、`jobs::tests` 3 项；工具调用**内部**无检查点的粒度见 §4，仍属限制而非缺陷。
7. 网络调用实际包体内可用；失败和超时具有明确诊断；默认离线能力不触网。 — 待补（阶段 B/C，打包版）。
8. `temp_usage` 不能通过任意路径获取其他目录下 `jobs/inbox` 用量。 — Verified：同第 4 项。
9. `invoice_undo` 使用无效 ID、被篡改或移动文件时不得删除；合法撤销有用户可理解的确认与结果。 — 部分 Verified：`invoice_tests::undo_is_refused_once_the_archive_directory_grant_is_gone`（无 grant、无效 ID、未知根）与 `invoice_archive_and_undo_preserve_verified_files`；「被篡改文件仍保留」由引擎哈希分支实现，UI 确认语义待实测。
10. 设置的输出/临时目录不能由自由 IPC 参数换取权限。 — Verified：`secure_paths_tests::a_configured_directory_grants_nothing_until_it_is_approved`、`access::tests::an_unapproved_directory_cannot_be_honoured_as_a_setting`、`a_write_only_directory_never_becomes_a_read_grant`、`an_approval_is_recorded_granted_and_survives_a_restart`。
