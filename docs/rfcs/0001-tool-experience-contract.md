# RFC-0001：工具体验声明与组件路由

- **状态**：分阶段实施中。2026-10-13 已落地「阶段 1 基础校验」：`experience` 成为 catalog 必填字段，98 项工具按 [审计矩阵](../audits/TOOL_UX_MATRIX.md) 的「目标模型 / 建议执行方式」逐项登记，`useToolDraft` 的执行节奏与过期结果状态改由该声明驱动（UX-03），并新增 `packages/core/tests/catalog_contract.rs::every_tool_declares_a_consistent_experience_model` 做机械校验。**页面模板与结果契约（阶段 2-3）仍未实施**，`ToolPage` 的主编辑器判断依旧基于 `layout`/字段形态。
- **背景**：2026-10-13 对 98 个工具 catalog、`ToolPage.tsx`、`OptionForm.tsx`、`ResultPanel.tsx` 的静态检查
- **关联**：[工具交互规范](../standards/TOOL_INTERACTION.md)、[工具开发规范](../standards/TOOL_DEVELOPMENT.md)、[工具矩阵](../audits/TOOL_UX_MATRIX.md)

## 已实施部分（2026-10-13）

Rust `packages/core/src/tools.rs` 与 TS 镜像 `apps/web/src/lib/core-contract.ts` 中的实际形状：

```rust
pub struct ToolExperience {
    pub kind: ExperienceKind,          // 七类 kebab-case 值
    pub execution: ExecutionMode,      // live | debounced | manual
}
```

- `resultView` **尚未引入**：结果渲染契约需要同时定义 `ToolResult.extra` 的可序列化形状与金样兼容策略，留到阶段 3，避免用一半的字段做出看起来完整的声明。
- 校验规则（`every_tool_declares_a_consistent_experience_model`）：七类模型均至少被一个工具使用；`live` 不得声明在有外联、多文件或 `generator` 类工具上；总数必须等于 catalog 工具数。
- `interaction` 字段暂时保留为兼容登记；`ToolPage` 的「实时提示 vs 运行按钮」已与 `experience.execution` 同源，不会再出现「无按钮也不自动跑」的工具。

**2026-10-13 评审后的偏离**：`interaction` **没有**保留为兼容后备，而是直接从 catalog、Rust `ToolDescriptor` 和 TS 镜像中删除（39 项登记 + `ToolInteraction` 枚举）。原因是全仓检索确认它已经没有任何运行时读者，而 39 项仍写着 `live`、与新的 `experience.execution` 互相矛盾——留着就是 RUN-03 刚清掉的那种「第二个事实源」。删除后 catalog 只有 `experience` 一处描述节奏，`packages/core/tests/catalog_contract.rs` 负责它的合法性。

## 问题

当前 `ToolDescriptor.layout` 主要为 `standard / organizer / splitter / metadata / image-grid / text`，当前页面把不少工具按 `textarea` 是否存在分配主编辑区，并在 `ToolPage` 中增加少量按工具 ID 的特例。`interaction: live` 可以选择调用节奏，却不足以表达结构化解析、可视化编辑、生成器、批处理及引导流程不同的输入与结果语义。

结果组件部分依赖产物文件名推断如何呈现（例如密码生成、颜色报告），不适合作为面向所有工具的稳定契约。

## 目标

1. 工具目录仍是 UX 元数据的唯一事实源；不复制算法和 Catalog 到 TS 常量表。
2. “页面交互模型”和“计算执行节奏”分开表达，结果优先按数据结构和呈现类型渲染。
3. 支持七种主模式与辅助组合，复用控件与任务基础设施，并支持少量专业工作台。
4. 不影响现有 Rust API 的兼容性，不迫使 98 项工具一次性迁移。

## 提议契约（`kind`/`execution` 已实施，`resultView` 等仍未支持）

```ts
type ExperienceKind =
  | 'instant-transform'
  | 'structured-inspector'
  | 'calculator'
  | 'generator'
  | 'visual-editor'
  | 'batch-processor'
  | 'guided-workflow';

type ExecutionMode = 'live' | 'debounced' | 'manual';
type ResultView = 'value' | 'editor' | 'structured' | 'visual' | 'files' | 'diagnostics';

interface ToolExperience {
  kind: ExperienceKind;
  execution: ExecutionMode;
  resultView: ResultView;
  preview?: 'none' | 'on-demand' | 'live';
  sourceInputField?: string;
  highlights?: string[];
}
```

实现时应在 Rust `ToolDescriptor` 和 TS 类型镜像中同步引入可选 `experience`（或通过生成的 schema 保持一致），并保留旧 `layout` / `interaction` 作为兼容后备。更复杂的结果如结构化字段需讨论可序列化数据契约（`ToolResult.extra` 的目前可表达范围与用户接口的实际消费），不允许从字符串/文件名解析生成 UI 业务状态。

## 推荐分层

```text
ToolRegistry (Catalog + runtime capability)
   └── ToolExperienceResolver（schema 合规、兼容旧字段）
        ├── InstantTransformWorkspace / InspectorWorkspace / CalculatorWorkspace
        ├── GeneratorWorkspace / VisualEditorWorkspace
        ├── BatchProcessorWorkspace / GuidedWorkflowWorkspace
        └── Shared: Field / Preview / ResultRenderer / Status / ArtifactActions
               ↓
           useToolDraft / job runner / transport / Rust engine
```

## 决策约束

- **不新建平行事实源**：表单字段仍由 catalog Rust 校验控制；体验模板只描述布局/时机/结果形态。
- **特殊能力显式声明**：按源路径写入、OCR、网络、文件批处理等能力不能因体验类型改变而偷偷启动。
- **不混淆 live 和 generator**：随机密码、UUID 的再生成语义不同于纯格式化转换；首次展示策略需经过用户测试。
- **全宿主能力表**：未来应提供可以对账的 Native/Worker/adapter 路由元数据，但这不属于首个 UX PR 的范围。
- **无障碍**：每套模板有键盘/焦点/读屏测试，不引入只靠拖拽的操作。

## 分阶段迁移（独立 PR）

1. **基础校验**：先补 catalog 静态契约及七类模型分类与对账，不改变页面布局。
2. **七个样板工具**：`json-format`（即时）、`jwt`（结构）、`cron`（计算）、`password-gen`（生成）、`image-crop`（可视）、`merge`（批量）、`invoice-organize`（引导）。
3. **结果契约**：提供类型安全的 structured result renderer，逐步替代文件名驱动的展示分支。
4. **迁移其余工具**：每项有视觉现状、行为差异、低级别回归测试和人工验收证据。
5. **清理兼容层**：完成所有工具迁移后，再讨论是否删除旧 `layout` / 特例路由。

## 待评审问题

- 是否将 `ToolExperience` 直接写入 catalog，还是以统一 Rust-generated manifest 派生（不可手动维护重复清单）？
- 哪些模型需要全双向编辑器，哪些只需只读结果？
- 结构化产物如何声明 schema 版本，怎样避免破坏旧金样？
- 对 Browser/Tauri/Win7 分别声明能力时，何种回退规则可被测试？
- 性能较差的 live 工具如何自动降级为 manual，而不使用户觉得操作无响应？

本 RFC 没有修改生产契约；PR 合入后方可按照已批准决策逐步实施。
