# PoTools V2 一次性全面重写计划

状态：目标计划。追踪：[Issue #2](https://github.com/pohoc/PoTools/issues/2)。

## 产品交付方式
独立 V2 代码树实现完整 TS Engine + Electron/Node + Web + 98 工具，**只在全部完成并通过单一 Cutover Gate 后发布替换 V1**。内部可按工作包并行开发/测试，不构成用户可安装的阶段性版本，也不能在 V2 运行时使用旧 Rust/WASM 兜底。

## 并行工作包（不是上线阶段）
| 工作包 | 完整产出 | 必需证据 |
| --- | --- | --- |
| 基线 | 从 V1 Catalog 锁定 98 工具、21 证件照尺寸预设、字段/默认值/错误/平台限制 | 全量清单与冻结 fixture |
| Core/Engine | TS registry、schema、runner、job 状态、取消、进度、资源预算、结果/产物 | 类型/契约/并发/故障与负面测试 |
| Runtime | Electron main/preload、Node trusted service、浏览器 runtime、进程隔离、系统授权 | OS 许可、IPC sender、路径拒绝、取消后禁止写入 |
| Tools | 密码学/时间/开发/网络/图片/PDF/OFD/Office/OCR/发票等全部工具 | 各工具依赖决策与正常/异常/边界金样 |
| 体验 | 七种交互模型、预览、typed result、批处理、结果、设置、双语、键盘/读屏 | 98 工具 UI E2E、取消/重试/过期状态 |
| 发行 | macOS/Windows/Linux 目标平台审计、第三方许可、签名、离线模型、自动更新 | 真机/打包 smoke、安全、升级与回退 |

## 技术高风险
- PDF→DOCX/XLSX/PPTX 的目标生成库不能自动重建 PDF 布局；OFD→PDF、字体/印章、PathObject 是专项难题。必须比较语义、结构、视觉和可编辑性，不能只检查文件能打开。
- OCR 本地模型、运行时架构、精度与表格重建逐项核验；发票归档需要撤销和数据完整性验收。
- Electron 原生模块和 CPU 架构不是 Tauri 等价替换。Windows 7/x86、Linux ARMv7、ppc64le、s390x 等要单独作支持决策，不许无凭据删除支持。
- MIT 自研代码不代表任意 AGPL/商业依赖可直接打包。所有包及模型、字体必须许可/安全/供应链审查。

## 一次性 Cutover Gate（缺一不可）
- [ ] 98/98 工具及 21 预设由 V2 TypeScript 完整实现，已建立逐工具依赖选择、浏览器/桌面能力和可复核测试证据。
- [ ] 输入、Schema、错误、结果、保存/下载、取消/重试、恢复与七类 UX 均通过双端回归；必要时有经负责人批准的公开差异。
- [ ] PDF/Office/OFD/OCR 各格式保真度、结构、布局、可编辑性、异常文件与资源预算通过专门测试。
- [ ] 文件只读/写授权、IPC 发送方验证、symlink/TOCTOU/zip slip、解压炸弹、取消后无输出及日志隐私测试通过。
- [ ] 每个宣称支持的桌面 OS/架构经真实构建、安装、启动、签名、离线资源、更新和卸载验证。
- [ ] TypeScript lint/typecheck/unit、98 tool golden、Web/Electron E2E、安全测试、SBOM 和 license 门禁强制通过。
- [ ] 最终发行不加载任何旧版 Rust/Tauri/WASM 引擎；有设置/历史数据备份、切换与可执行回退演练。
- [ ] 所有 Blocker 关闭，批准的限制列表有负责人签字且公开；没有部分完成即发布。

V1 继续使用原有 docs 标准；新标准只约束 V2 新实现。
