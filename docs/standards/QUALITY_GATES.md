# 测试与质量验收规范（Quality Gates & Acceptance）

**目的**：把「代码检查通过」与「98 个工具可正确使用」明确区分。本文件既记录现有门禁（Observed），也定义需要落实的目标门禁（Target）。

## 1. 当前实际命令（Observed）

| 命令 | 范围 | 是否包含在 `pnpm check` |
| --- | --- | --- |
| `pnpm version:check` | manifest 版本一致 | 是 |
| `pnpm lint` | oxlint | 是 |
| `pnpm typecheck` | TS 类型检查 | 是 |
| `pnpm licenses:check` | 依赖许可清单 | 是 |
| `pnpm rust:fmt` | Rust 格式 | 是 |
| `pnpm rust:clippy` | Rust 静态检查 | 是 |
| `pnpm rust:test` | Rust 单元/集成测试 | 是 |
| `pnpm rust:check:wasm` | wasm32 目标可编译 | 是 |
| `pnpm test:unit` | `apps/web/tests/*.test.ts` | **否** |
| `pnpm test:tools` | 浏览器工具金样 | **否** |
| `pnpm --filter @potools/web build` | Web TS + WASM smoke + Vite 包 | 独立 CI bundle job |

注意：根 `test:unit` 当前使用 `node --test "apps/web/tests/*.test.ts"`；仓库允许的部分 Node 版本无法直接运行 TS。应选择兼容的测试运行器或明确最低 Node 版本，修复前不要宣称它在全部声明环境下通过。

CI 位于 `.github/workflows/ci.yml`。发布配置 `.github/workflows/release.yml` 使用 tag 构建，需另审签名、跨平台启动/升级，不应假定 CI 无误就等于发行包完整。

## 2. 建议 CI 强制关卡（Target）

```text
contract + schema + i18n + license
          ├─ lint + typecheck + TS unit
          ├─ Rust fmt + clippy + Rust tests + wasm32
          ├─ WASM build + startup smoke + Web bundle
          ├─ browser golden: all catalog-supported tools
          ├─ security/path/IPC negative tests
          └─ release build: platform packaging + smoke + signature
```

- 文档阶段只定义目标，不会自动令 CI 生效；应以独立 PR 增加工作流并保留失败证据。
- 任何不支持 Web 的工具，必须在 catalog / capability 表中标注且在 UI 有清晰的不可用说明；测试不得用“跳过”掩盖意外不支持。
- 每次工具 ID/选项/结果 ABI 改动，至少运行 catalog 双向登记、金样、参数边界、异常错误码、WASM 与 Native 对比。
- 关键安全回归必须验证 **未经授权的 Native IPC 直接调用**，不能只从正常 UI 流程点击按钮。

## 3. 工具测试分层

| 层次 | 核心用例 | 验收输出 |
| --- | --- | --- |
| Contract | catalog ID 唯一、字段 key 唯一、默认值类型、选项枚举、双语 key、router 能力对账 | 具体工具和字段的诊断 |
| Rust unit | 对正常/极值/畸形参数、页码范围、格式读写、错误码、panic guard | 确定性断言 |
| Tool golden | 真实样例、内容断言、格式往返、警告、错误、产物名 | 无意外差异；变更需人工审查基线 |
| Browser E2E | WASM 初始化、Worker、文件/内存上传、预览、导出、live 竞态 | 成功/失败/取消/过期状态 |
| Tauri E2E | OS 授权、IPC、路径读写、Native/WASM 路由、打开结果 | 授权与产物可追踪 |
| UX & accessibility | 首次完成任务、键盘、读屏、窄窗口/桌面、浅色/深色 | 无误操作/阻断操作 |
| Release | macOS/Windows/Linux 打包、签名、升级、离线资源、Win7 独立限制 | 可以安装、启动和完成典型任务 |
| Performance | 1/20/100/500 MB（按能力与限额选取）、批量、多 Worker、超大图片 | 峰值内存/耗时有预算，能安全拒绝 |

## 4. 每项工具的最低可验收场景

- **正常**：至少 1 个典型输入得到已知正确结果；可复制或保存，产物能重新打开。
- **边界**：空值、最大/最小参数、无效页码、非目标文件类型、超限文件、非 ASCII 路径。
- **异常**：损坏文件、权限拒绝、网络超时、Worker 失败、内存预算超限、输出磁盘不可写。
- **状态**：连续改输入不出现旧结果，运行中取消不产生成功结果，重试保留用户设置。
- **可用性**：没有阅读开发文档也能完成主任务；所有重要字段有单位/说明，结果直接可使用。
- **可访问性**：无鼠标完成主要路径，label / focus / 错误播报 / 对比度满足规范。
- **平台**：分别标注 Web、Tauri、Win7 可执行/限制/不支持；真实打包版检查 CSP 与系统服务。

## 5. 代表性跨模型回归集（先建立模板）

| 代表工具 | 必测重点 |
| --- | --- |
| `json-format` | 长文本、无效 JSON 行列、格式化和压缩结果、实时旧结果竞态 |
| `jwt` | 解析与验签显著区分，过期 claims、错误签名、隐藏敏感密钥 |
| `cron` | 时区、跨日、夏令时、未来 N 次运行时间 |
| `password-gen` | 随机性接口、策略调整不丢失正在复制值、批量复制 |
| `image-crop` | 画布与参数一致、边缘裁剪、原图保护和导出尺寸 |
| `merge` | 文件与页顺序、密码保护/损坏 PDF、合并后产物检查 |
| `invoice-organize` | 未授权扫描/读/归档拒绝、人工复核、部分成功、撤销 |

只有代表性测试合格并不能证明 98 项工具全部完成：每个目标模型迁移后仍需逐项验收，并在 [矩阵](../audits/TOOL_UX_MATRIX.md) 标记证据。

## 6. PR / 验收报告模板

```markdown
### 变更工具 ID
- 工具：
- 目标交互模型 / 修改范围：
- Browser / Tauri / Win7 支持范围：
- 原行为与新行为（含无效/取消/重试）：
- 涉及网络/路径授权/敏感数据：
### 自动测试（贴真实结果）
- [ ] pnpm check
- [ ] pnpm test:unit
- [ ] pnpm test:tools
- [ ] Web build + smoke
- [ ] 新增异常 / 权限 / regression 用例
### 人工验收（标注系统、包版本、测试输入）
- [ ] 正常结果 / 可复制与另存
- [ ] 错误反馈 / 取消 / 重试 / 文件未损坏
- [ ] 多分辨率 / 键盘 / 两语言 / 两主题
- [ ] 正式打包版特权/网络能力（如适用）
### 剩余风险与回退
- 未运行项及原因：
- 已知限制：
- 截图、录屏、金样：
```
