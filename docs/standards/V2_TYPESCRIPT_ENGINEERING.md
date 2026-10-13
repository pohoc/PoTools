# V2 TypeScript Core/Engine/Tool 开发规范

**仅用于新的全量重写 V2；V1 Rust/Tauri 的现行规范继续有效。**

- 使用 strict TypeScript、单一 pnpm workspace、统一 ESM/构建工具、固定锁文件及受支持 Node/Electron/TS 版本矩阵；避免 any，未知输入统一 runtime Schema 校验。
- 模块边界：UI 依赖 contracts，不访问 Node fs；engine 依赖 contracts/adapter interfaces；tools 通过语义 adapter 使用第三方；runtime-node 持有系统权限，runtime-browser 由 Worker/浏览器 API 承载。禁止跨包私有深层导入。
- 每项工具唯一 ID、输入选项和默认值、结果 Schema、可用平台、交互 kind、执行 live/debounced/manual、声明的资源预算及依赖决策均来自单一 Registry。强制双向测试与 i18n 校验。
- ToolContext 包含 `signal: AbortSignal`、有授权的文件引用、进度回调、受限日志、ArtifactWriter 与 capability；不可向 renderer 传递原生文件任意写 API。
- 状态为 `queued → preparing → running → staging → succeeded|failed|cancelled`。同一任务终态不可反转；generation 防旧结果覆盖；取消在最终发布之前重新检查；出错保留原始输入并报告部分产物。
- 按原有七类工作台使用不同的输入、即时反馈、预览、结果与重试 UI；**不允许靠产物文件名判断结果类型**。
- 添加工具前须写使用场景、依赖候选、权限和数据流、正确性/UX/安全测试与平台能力；完成后提供真实输入、金样/错误/边界、Web/Electron E2E、键盘/读屏与双语验证。

PR 可在**独立 V2 工作空间**并行实现，但未达到完整发布门禁不得替换 V1 或向用户交付部分混合版。参见 [一次性重写计划](../plans/typescript-v2-full-rewrite.md)。
