# V2 全量重写质量与统一发布门禁

**目标要求，尚非现有 CI 执行结果。**

要求强制 CI：TypeScript strict/typecheck/lint、schema & 98 Tool Registry 双向登记及 21 预设、单元测试、98 项工具金样（正常/边界/错误/取消/大文件）、Node/Browser 行为对账、七类工具 UI E2E、Electron IPC 负面测试、依赖漏洞/许可/SBOM、真实发行包 smoke/签名/升级/回退。

PDF、Office、OFD、OCR 的金样不仅验证文件能打开，还需比较页面/文本/布局、结构与目标可编辑性、图片视觉、字体与真实系统差异。不能只比 SHA。Worker 崩溃、慢任务取消、重复提交、旧状态反转、staging 写出与恶意文件必须有用例。

每条工具验收至少存储：`toolId, runtime, inputFixture, options, dependencyDecision, expectedResult, errorCases, outputChecks, UX, accessibility, OSArch, evidence, reviewer, status`；状态 planned/implementing/blocked/verified/approved-exception。只有证据充分才能 verified；批准差异必须公开透明。

**单一 Cutover Gate**：98/98 工具、完整体验、安全、支持平台、资源和许可证、打包更新及回滚全部通过后，才允许新 Electron + TS 一次性取代 V1。任何“先上线一半再补”或旧 Rust runtime fallback 均不合格。
