# V2 Dependency-first：优先第三方包开发规范

目标：**可用成熟包实现的能力，禁止无理由重复自研**。PoTools 自有 Core、Engine、流程、工具契约为 TypeScript，但允许经过评审的原生 NPM 模块、WASM 和模型资源。

## 包的选择顺序
1. Node.js/Web 标准 API。
2. 合规、维护中的成熟第三方依赖。
3. 组合多个成熟包并用轻量 TS adapter 连接。
4. 只有经记录的库能力缺口才准最小范围自行实现。

必须记录每个候选包的覆盖率、API/性能、发布维护、直接与传递依赖许可、漏洞/SBOM、离线运行、包大小、macOS/Windows/Linux/CPU 架构支持、浏览器支持、恶意输入预算、降级方案、测试 fixture。未检验的项目只能是 `candidate`，不是 `approved`。

## 候选库（不代表通过验证）
| 功能 | 优先考察 | 不可忽略 |
| --- | --- | --- |
| 图片处理 | sharp | Native/libvips/架构/EXIF/颜色精度 |
| PDF 基础 | pdf-lib | 不代表能提取完整文字或支持全部 PDF |
| PDF 渲染/文字 | pdfjs-dist | 结构、字体与布局/大文档资源 |
| Office 输出 | docx、exceljs、pptxgenjs | 仅生成目标文件，不等于 PDF 结构重建 |
| OCR | onnxruntime-node、onnxruntime-web | 本地模型、推理前后处理、架构、授权 |
| OFD | ofdjs 等候选 | PathObject、签章/字体/解析完整性必须核验 |
| 密码/日期/协议 | node:crypto、jose、date-fns、可信解析库 | 正确性向量、浏览器差异 |
| 参数验证 | zod 或 ajv | 防止两套 Schema 真相源 |

业务仅依赖领域能力接口，由 Adapter 映射第三方 API、错误、权限、取消、资源预算及结果；不做无意义薄封装。包不足时可补针对性 TS 逻辑，不擅自降低功能，也不将本地文件隐式上传云端。

新增依赖 PR 必须附依赖决策记录、许可证/漏洞证据、平台/浏览器可用性、替代品、golden 回归；未经许可检查的 AGPL/商业限制包不得并入发行。
