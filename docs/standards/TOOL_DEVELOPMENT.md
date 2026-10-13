# 工具全链路开发规范（Tool Development Standard）

**目标**：开发人员按同一顺序新增、维护或迁移任一工具，保证 catalog → UI → transport → adapter/native → Rust → artifact 的链路可解释、可测试、可恢复。

## 1. 先完成工具设计卡（写代码前）

每项工具最少明确：工具 ID / 用户一句话任务、典型输入文件与尺寸、预期输出和示例、是否含秘密或网络、浏览器/桌面支持矩阵、交互原型、运行成本、是否可重试/取消、失败场景、验收标准。不要以「一个新下拉字段」代替用户流程设计。

| 设计问题 | 建议决策 |
| --- | --- |
| 用户的主要动作是什么 | 输入即变换 / 结构解析 / 计算 / 生成 / 可视化编辑 / 批处理 / 引导流程 |
| 多快出结果 | `live` 仅适用于廉价且无副作用计算；`debounced` 用于需轻量校验的大输入；耗时/联网/写文件必须 `manual` |
| 结果以何种形态使用 | 值、结构、代码编辑器、差异对比、画布/图像、文件列表、诊断 |
| 处理放在哪里 | Rust 处理与规则；Web Worker 可运行的 WASM；Native 能处理的路径优先走本地 IPC |
| 异常与恢复方式 | 输入校验、错误原因、无效结果标记、取消/重试、保留原文件 |
| 如何证明正确 | 最小样例、异常样例、真实文件、Browser + Desktop、回归 |

交互分类及参数见 [交互规范](TOOL_INTERACTION.md)，98 工具目标见 [矩阵](../audits/TOOL_UX_MATRIX.md)。

## 2. 实现与登记顺序

1. **Catalog**：在对应 `packages/core/catalog/<domain>.json` 加描述符；保证 `id` 唯一，`fields[].key` 唯一，`nameKey` / `descKey` / 选项 `labelKey` 双语存在；`default` 类型、`showIf` 与引擎规则一致。
2. **Core**：如引入新字段类型、页码规则或协议，先修改 `packages/core/src/fields.rs` / `tools.rs` / `protocol.rs`，同步纯类型镜像 `apps/web/src/lib/core-contract.ts`。
3. **Engine**：实现于 `packages/engine/src/tools/<domain>`，使用 `RunContext` 接收 options、inputs、locale、runtimeData；返回 `ToolResult { text, artifacts, warnings, extra }` 或结构化 `EngineError`。
4. **路由**：接入 `packages/engine/src/lib.rs` 的业务 domain dispatcher，并更新 `tools/capabilities.rs` 的 `SUPPORTED` / `ENGINE_ONLY` / `ADAPTER_HANDLED`。三组集合不得相交；目录工具必须能找到实现。
5. **宿主前置**：如需要 PDF.js 页面、Canvas 像素、OCR 推理、DNS / 系统字体，明确 `runtimeData` 结构、最大字节数、来源与失败码；在 `apps/web/src/lib/embedded-engine.worker.ts` 或专用 adapter 编排。不要悄悄复制 Rust 算法到 TS。
6. **原生特权**：只在 `apps/desktop` 接入必须的 Tauri 命令，经过授权验证；不要让 UI 传入任意路径后直接做 IO。所有耗时原生命令检查取消和进度。
7. **UI**：根据目标体验装配主输入、次级设置、即时预览、结果面板、状态反馈；复用 `packages/ui` 组件和国际化，不为常规工具复制一整页 JSX。
8. **产物**：文件名需净化且避免覆盖；正确维护 sourceFileId、sizeBytes、临时路径与最终路径；浏览器下载及桌面另存各自验证。
9. **测试和文档**：新增金样和错误路径、跨宿主用例、权限用例，更新工具矩阵、限制说明与实际支持范围。

## 3. 现有工具调用契约（Observed）

```text
core/catalog/*.json
  └─ Rust all_tools() / WASM coreAllTools()
       └─ apps/web core-bindings: installToolCatalog() → TOOL_LIST / TOOLS
            └─ ToolPage / OptionForm / useToolDraft
                 └─ transport
                      ├─ tool.run → (Tauri engine_run_text_tool) 或 Worker dispatch
                      ├─ job.submit → EmbeddedJobRunner
                      │    ├─ RUST_NATIVE_FILE_TOOLS → engine_run_file_tool（路径/字节）
                      │    └─ Worker → PDF.js/Canvas/OCR adapter → Rust WASM
                      └─ invoice.* / file.* / fs.* / shell.* → 专用 Tauri 命令
                              ↓
                         ToolResult / JobSnapshot
                              ↓
                     临时产物 → 指定目录 / 浏览器下载
```

目前路由列表（例如 `RUST_NATIVE_FILE_TOOLS`）仍在 TS 中维护，未完全由 catalog 推导；**不得把该链路视为无差异执行**。

## 4. 字段、显示与校验

- 表单字段的机器标识为 `key`，显示文案永远来自 i18n；枚举的稳定值不能使用中文标题本身。
- `showIf` 是 schema 条件，前端显示由 `visibleFields` 推导；隐藏选项如何传给引擎应有可预测规则，不能以「隐藏即删值」作为默认。
- `uiOnly` 字段不直接作为引擎算法选项；把 UI 的 mm、百分比、日期预设转换为引擎单位时必须保证转换可逆或精度定义明确。
- 前端 `areOptionsValid` 只改善体验，不能替代 Rust 输入校验；Rust 要对直接 RPC、畸形 options、错误格式、过大数据也安全失败。
- 文件格式判定不能只靠文件扩展名、MIME 或 dropzone accept，必须检查真实内容并返回明确错误。
- 校验错误按字段、表单和任务结果分别显示，不可用静默失败掩盖请求未发出。

## 5. runtimeData 与宿主契约

为每一种新宿主数据写明：`schema`、单位、顺序、是否选填、生成方、可信度、内存预算、版本、适用宿主、失败回退。例如：

```ts
// 概念示意，非当前 Rust/TS 已实现 API
type PageRasterRuntimeData = {
  kind: 'page-raster';
  version: 1;
  page: number;
  widthPx: number;
  heightPx: number;
  // 不直接在业务选项中塞大体积 base64
};
```

宿主预处理只提供数据，Rust 承担生成文件的核心规则。Tauri 环境下，应尽可能避免先经 JS 读取整个文件、再由 Rust 用路径重复读取；只有实际需要像素 / 预览的步骤才应物化字节。

## 6. 运行与产物状态机（Target）

```text
queued → preparing → running → staging → succeeded
   └───────────→ failed / cancelled
```

- 允许在排队阶段取消，运行中应协作式中断；取消后禁止发布新的成功终态或自动写入最终目录。
- 终态有且只有一次；带任务序号或 generation 的异步结果不得覆盖较新状态。
- `failed / cancelled / succeeded` 不应在刷新任务列表时无故消失；清理只针对明确的终态任务。
- 自动写入路径须经特权侧授权，拒绝应返回诊断并保留可用临时产物，不可静默地转到不可预期目录。
- 失败时保留源文件；如部分产物已写出，报告部分成功/补偿状态及已写出路径。

## 7. 新工具 PR 验收卡

```markdown
- [ ] ID / catalog / schema / locale / icon / 分类登记完成
- [ ] 描述目标交互模型、运行模式、结果呈现及失败恢复
- [ ] Rust/WASM dispatch 与类型契约一致，能力名单双向对账
- [ ] 如用 adapter，runtimeData 的版本、限额、缺失错误已定义
- [ ] Native IO 与网络路径在 Rust 授权，权限拒绝可测试
- [ ] 正常 / 边界 / 错误输入有样例；源文件未被误修改
- [ ] 浏览器 + Tauri 真实文件实测；Win7 支持范围显式标注
- [ ] 文件大小、并发、取消、重试和清理行为已核对
- [ ] 双语文案、键盘/ARIA、浅色深色主题通过检查
- [ ] 工具矩阵、变更记录和测试结果同步更新
```

详尽的测试矩阵在 [质量门禁](QUALITY_GATES.md)；安全审查在 [引擎/安全规范](ENGINE_SECURITY.md)。
