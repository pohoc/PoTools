# 工程开发规范（Engineering Standard）

**适用范围**：PoTools workspace 内全部 Rust、TypeScript、UI、WASM、Tauri、脚本及发布改动。**状态**：目标规范，除注明「现存差距」外，新代码应立即遵守。

## 1. 架构边界

```text
apps/web: React 页面、状态、浏览器 Worker/adapter、用户输入与可视化
    │ tool.run / job.submit / 专项 RPC（transport）
    ├── Web Worker → packages/engine WASM → packages/core
    └── Tauri IPC → apps/desktop 授权/特权服务 → packages/engine Native
packages/ui: 可复用组件/设计 token
packages/core: 协议、字段、catalog、平台无关校验
packages/engine: 单份 Rust 业务处理、文件格式与通用运算
scripts: 构建、样例、打包和版本检查
```

- **单一事实源**：工具元数据在 `packages/core/catalog/*.json`，Rust `packages/core/src/tools.rs` 负责反序列化；JS 的 `core-contract.ts` 是类型镜像，不另存一份 catalog。
- 纯算法、规则、文件序列化、错误码归属于 Rust；Web adapter 只供浏览器特有能力（PDF.js/Canvas/OCR/WASM 辅助输入），Tauri 提供文件授权、系统网络、shell 等特权能力。
- UI 不得直接依赖 Native 文件系统，Rust engine 不得依赖 React、DOM、WebView；平台能力通过明确契约输入 `runtimeData`。
- **不允许把“当前可运行”解释为“跨平台能力相同”**。需记录每个工具 Web/Tauri/Win7 的支持、限制与实际执行路由。
- 专项工作流可以有专用页面，切忌为每个工具在 `ToolPage` 中叠加 ID 硬编码；渐进迁移方案见 [RFC](../rfcs/0001-tool-experience-contract.md)。

## 2. 代码约定

| 事项 | 强制要求 |
| --- | --- |
| JavaScript / TypeScript | strict 类型、两空格缩进、显式错误处理；组件 PascalCase，变量/函数 camelCase |
| Rust | stable、`cargo fmt`、Clippy `-D warnings`、错误用结构化 code + message；路径 / IO 用 `Result` |
| 文件组织 | 建议新改动的单文件尽量不超过 500 行；这是本规范新增的可维护性建议，不是旧有 CI 门禁；超过时解释职责与拆分计划，不为凑行数制造无关改动 |
| UI 文案 | 用 `apps/web/src/i18n/zh-CN.ts` 与 `en.ts`；禁止直接加入未经国际化的用户可见字符串 |
| 样式与无障碍 | 控件识别边界用 `--ui-control-line`，装饰分隔用 `--ui-line`；键盘、焦点、ARIA、WCAG 2.2 1.4.11 |
| Git 提交 | `type(scope): summary`，优先 `ui / engine / core / tauri / docs / test` |
| 依赖 | pnpm lockfile 固定、Rust Cargo lockfile 同步；引入新依赖需评估包体积、许可、安全更新与离线运行 |
| 生成物 | 不提交可重建的运行产物（除仓库明确要求保留的 WASM 类型声明等） |

**维护性改进候选**：`apps/desktop/src/lib.rs` 与 `apps/web/src/pages/ToolPage.tsx` 等已超过建议的 500 行。原始 `AGENTS.md` 没有这条硬性上限；应按职责与变更风险分批拆分，而不是为了满足行数机械拆文件。

## 3. 开发环境

- Node 要求以根 `package.json#engines` 为准；workspace 使用 `pnpm@12.5.1`，Rust stable + rustfmt + clippy + wasm32 target。
- `wasm-bindgen-cli` 与引擎 ABI 版本须匹配，当前构建脚本要求 `0.2.129`。
- 桌面环境还需要 Tauri 系统依赖；Linux 原生打包应在目标架构环境构建，不得等同发行版认证。

```bash
pnpm install
pnpm dev:web                         # 浏览器 UI + Worker
pnpm tauri dev                       # Tauri Native
pnpm wasm:build                      # WASM ABI
pnpm --filter @potools/web build     # Web bundle + 启动 smoke
pnpm check                           # version, lint, typecheck, licenses, Rust, wasm32
pnpm test:unit                       # 前端纯函数测试；留意 Node 版本兼容
pnpm test:tools                      # 浏览器金样，需满足 WASM/浏览器依赖
```

> `pnpm check` **当前不包含** `test:unit` 或 `test:tools`。开发者需显式运行；CI 补足项见 [质量规范](QUALITY_GATES.md)。本次文档不会将缺失步骤误写为已在 CI 强制执行。

## 4. 修改过程中的边界

1. **业务变更先改契约**：字段类型、必填、默认值、`showIf`、输入/产物格式都必须可追踪；工具 UI 与 Rust 接收的 options 必须一致。
2. **接口兼容**：`PROTOCOL_VERSION` 有显式意义；若更改 RPC 返回结构或序列化 ABI，需确认 Browser Worker、Native 命令和依赖 UI 的兼容范围。
3. **状态不可猜测**：执行前校验输入；执行中区分准备/处理/写入；最终状态不可被迟到事件逆转。
4. **资源受控**：大文件惰性读取与零拷贝优先，限制像素、页数、内存、并行度；不得因为预览或汇总再次读取全部源文件。
5. **安全先于便捷**：每一个读、写、复制、移动、删除、shell 打开与网络入口必须在特权侧验证授权，而非相信前端传参。
6. **持久化慎重**：默认选项、原始文件、密钥/Token、临时产物不能未经明确设计就跨会话保存。
7. **纯函数与副作用分离**：核心算法可单测；文件 IO、网络调用、UI 调度有各自契约和针对性测试。

## 5. PR 必填内容

PR 描述至少包含：问题与用户价值、受影响工具 ID、架构层、运行宿主、权限及数据流、兼容性/许可影响、测试命令与结果、手工复现步骤、UI 截图/录屏（若适用）、未覆盖场景和回退方式。未运行的命令注明「未执行」，不要虚报通过。

需要变更产品交互模式的 PR，必须先更新 [工具体验矩阵](../audits/TOOL_UX_MATRIX.md) 对应行，明确迁移前后行为；全局交互变更优先提交 RFC。
