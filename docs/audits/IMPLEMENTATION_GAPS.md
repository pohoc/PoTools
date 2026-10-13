# 实现差距、技术风险与整改登记

> 静态审查基线：`88acacba375f25a6f3980a1faacc03cf5b4cebb9`，2026-10-13。本表为任务账本，列举有代码依据的风险，不等于已经进行漏洞利用、完整 Tauri 动态测试或逐工具用户测试。**本次文档 PR 不修复这些代码问题**。

## 0. 状态说明

- **代码确认**：可在源代码中指出具体执行路径或配置缺口；不表示危害在所有系统上复现。
- **待实测**：结论涉及 CSP、平台差异、内存/取消竞态、复杂文件或具体使用体验，需要实测后确认。
- **目标验收**：整改 PR 应达到的性质，尚未实现。
- **严重性**：P0 为存在明显越权或破坏性边界的优先阻断，P1 为功能一致性、质量与高影响逻辑，P2 为治理/体验与局部修复。

## 1. 优先问题清单

| ID | 级别 | 状态 | 位置 | 问题 / 影响 | 目标验收 |
| --- | --- | --- | --- | --- | --- |
| SEC-01 | P0 | 代码确认 | `apps/desktop/src/lib.rs` 发票 IPC 与 `services/invoice/` | `invoice_scan_list` / `invoice_read_candidate` / `invoice_archive` 缺少 `PathGrants` 源/目标范围检查。拥有 WebView IPC 能力的脚本可能枚举或读取未选取路径、执行非授权归档 | 未经用户选择源目录不能扫描或读，目标未授权不能写；直接调用 IPC 的负面测试通过 |
| SEC-02 | P0 | 代码确认 | `apps/desktop/src/lib.rs` 的 `set_output_dir` / `set_temp_dir` / `temp_clean` | 自由路径进入授权或清理，不等同于可信 OS 手势；清理根目录由调用者提供 | 任意传入根路径不得得到目录写 grant 或删除其 `jobs/inbox`，保留可信设置来源 |
| RUN-01 | P1 | 代码确认 | `apps/web/src/lib/transport.ts` `resolveInput` / `embedded-jobs.ts` `submit` | 磁盘输入先进入 JS 字节数组，原生任务又传路径让 Rust 重新读，造成不必要 IPC/内存往返 | Native 任务不经 JS 预读整文件，按需预处理例外被测量并记录 |
| RUN-02 | P1 | 代码确认，效果待实测 | `embedded-jobs.ts` `cancel` / `engine_run_file_tool` | Worker 取消机制无法中断已提交的原生 Rust 文件任务；旧结果可能到达并发布成功 | Native 有明确取消 token；取消后不能写最终产物或覆盖终态 |
| RUN-03 | P1 | 代码确认 | `transport-shared.ts` `RUST_NATIVE_FILE_TOOLS` / Rust `capabilities.rs` | 执行路由与能力列表两处维护，目录有实现不保证走理想宿主 | 建立可测试路由契约，解释各工具 Browser / Tauri 路由和退化策略 |
| NET-01 | P1 | 配置冲突确认，包体待实测 | `tauri.conf.json` CSP / `textToolRuntimeData` | `ip-lookup` 浏览器请求外部 API 与桌面 CSP `connect-src` 不一致 | 最终打包版查询成功或明确退化，外联范围受限且可诊断 |
| QA-01 | P1 | 代码确认 | 根 `package.json` / `ci.yml` | `pnpm check`、CI 未包含 `test:unit` / `test:tools`；`node --test` 直接跑 `.ts` 不能覆盖声明支持的全部 Node 版本 | CI 有单测+金样强制关卡，测试运行器兼容最低声明 Node |
| REL-01 | P1 | 代码确认 | `.github/workflows/release.yml` | 发布资源重命名、Updater 清单硬编码 `0.1.0`，版本升级将找不到预期资源 | 基于 tag/version 计算资源名，非 0.1.0 的演练版本成功 |
| UX-01 | P2 | 代码确认 | `useToolDraft.ts` live 效应 | 当输入从合法变为不合法时直接返回，可能继续展示上次可复制结果 | 清空过期结果或显著标注「与当前输入不一致」 |
| RUN-04 | P2 | 代码确认 | `embedded-jobs.ts` unsupported 分支 | 发布失败快照后立即 `jobs.delete`，列表刷新可能丢失失败记录 | 失败/取消记录保留到用户清理；watchdog 刷新稳定 |
| CAT-01 | P2 | 需新增自动检查 | `core/catalog/*.json` / `tools/capabilities.rs` | 能力列表已有对账，但字段 key 重复、默认值类型、双语翻译、schema 交叉引用没有集中强制检查的证据 | Schema/l10n 检查报出文件、工具和字段级错误 |
| WIN-01 | P2 | 代码确认，攻击效果待实测 | `apps/legacy-win7/main.js` | 使用 `file.startsWith(dist)` 判断静态目录包含关系，并直接对 URL 调用 `decodeURIComponent`，需防同前缀路径及非法编码异常 | 基于 `path.relative` 的真实目录边界、异常输入 HTTP 测试 |
| GOV-01 | P2 | 代码确认 | `AGENTS.md` / 大型服务和页面 | 声明建议 500 行以内，但 `desktop/src/lib.rs`、`ToolPage.tsx`、`OptionForm.tsx` 持续增长；专项逻辑难以拆分复用 | 分层拆出模块，每次 PR 有变更范围和回归覆盖 |

> 关注安全：`SEC-01` / `SEC-02` 的前置条件是能够调用桌面 WebView IPC；不能在未证明的情况下宣传为远程零点击漏洞。所有问题均保留为“未修复”，直至对应代码 PR 和可复现测试合入。

## 2. 优先复现与验收建议

### SEC-01 / SEC-02：路径与数据权限

- 从测试 WebView 以无 grant 的绝对路径调用 `invoice_scan_list` 与 `invoice_read_candidate`，要求路径授权拒绝且不返回元数据/字节。
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
| A：安全阻断 | SEC-01、SEC-02、必要 IPC 授权重构 | 权限负面测试通过，文件未被改写/清除 |
| B：引擎运行契约 | RUN-01/02/03/04、NET-01 | Native/Worker 行为明确、取消与网络可验证 |
| C：质量与发布 | QA-01、CAT-01、REL-01、WIN-01 | CI 强制门禁及模拟发布成功 |
| D：工具交互 | UX-01、GOV-01 + [98 工具矩阵](TOOL_UX_MATRIX.md) | 七类模板先经真实使用验证，随后逐域迁移 |

每个整改 PR 应在本表添加：状态、负责人、Issue/PR、验证系统、测试命令、复现材料和最终结论。不推荐只改文本为「已完成」而无测试证据。
