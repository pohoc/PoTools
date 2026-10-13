# RFC-0002：PoTools V2 全量 TypeScript 重写

状态：目标提案，非当前实现。追踪：[Issue #2](https://github.com/pohoc/PoTools/issues/2)。

## 一次性重写决策
PoTools V2 是独立的新实现，**不是渐进迁移**：自研 Core、Engine、Tools、任务、文件、安全、UI 均使用 TypeScript；桌面 Electron + Node.js，浏览器 React + Worker。允许经许可和兼容性审计的第三方原生 NPM/WASM 包，但 V2 运行时不得依赖、调用或回退到 V1 自研 Rust/Tauri/WASM 引擎。V1 保留为只读行为和金样对照，并在 V2 一次性切换前继续维护。

全部 98 项工具及 21 个证件照预设、七类交互、两端能力、用户文件安全、OCR、PDF/Office/OFD、更新打包都必须完成后一次性替换。**内部可并行开发和合并独立 V2 工作包，但中途不得发布混合版或按领域上线。**

## 目标模块
- `apps/desktop` Electron main、preload 白名单、渲染进程
- `apps/web` React、BrowserRuntime、Web Workers
- `packages/contracts` 版本化工具 Registry、输入/输出 Schema、错误与 capability
- `packages/core` 纯 TypeScript 工具语义/规则
- `packages/engine` JobRunner、并发/取消/资源预算、临时输出与原子提交
- `packages/runtime-node` 可信 Node 文件/网络/进程适配
- `packages/runtime-browser` 浏览器文件/Worker/Canvas 适配
- `packages/tools` 98 工具和选用的算法/格式适配
- `packages/ui` 七类工作台、结构化结果、无障碍、国际化

渲染进程/用户文件不可信；所有 privileged IPC 在 Node 侧做 sender、schema、授权、路径、预算检查。原输入默认只读；输出经 staging/授权/取消守卫。不可在 Electron 主线程执行阻塞文档处理。

## 明确拒绝的方案
1. 逐域迁移到 V1 main 或分批上线：与全量一次性替换目标相反。
2. V2 借 Rust 旧引擎作为 fallback：与 TS Core/Engine 完整重写目标相反。
3. 手写已有成熟的图片、PDF、密码学等库：除非有经过证据确认的能力缺口。
4. 未经测试默认 Electron 与旧 Tauri 支持相同系统架构。

**详细执行与单一验收门禁**见 [重写计划](../plans/typescript-v2-full-rewrite.md)。
