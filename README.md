# PoTools 工具箱

PoTools 是本机文件处理工作台，提供文档、图片与格式转换工具。PDF 是当前最完整的工具组，此外已支持 Office、OFD、Markdown 与常见图片格式。**所有处理都在这台电脑上的 Node 子进程里完成，文件不会离开本机。**

技术栈：**Vite 8 + React 19 + TypeScript**（界面） · **Node.js sidecar**（PDF 引擎） · **Tauri 2 + Rust**（桌面壳）

---

## 1. 架构

```
┌──────────────────────────────────────────────────────────────┐
│  Tauri 宿主 (Rust, apps/desktop/src-tauri)                    │
│  · 窗口 / 菜单 / 原生文件对话框 / 拖放文件路径                  │
│  · engine_start|write|stop  ← 负责拉起并转发 Node 子进程        │
└───────────────┬──────────────────────────────────────────────┘
                │  spawn `tsx packages/engine/src/index.ts serve --stdio`
                │  ndjson JSON-RPC (stdin/stdout) + engine://line 事件
┌───────────────▼──────────────────────────────────────────────┐
│  Node 引擎 (packages/engine)                                  │
│  pdf-lib  结构操作   ·  MuPDF-WASM  页面光栅化                 │
│  sharp    图片重编码 ·  fontkit     中文字形子集嵌入            │
│  JobManager：队列 / 并发 / 进度事件 / 取消 / 产物落盘           │
└───────────────▲──────────────────────────────────────────────┘
                │  浏览器开发模式：HTTP + SSE (127.0.0.1:8787)
┌───────────────┴──────────────────────────────────────────────┐
│  Vite + React (apps/desktop/src)                              │
│  工具箱首页 / 工具页 / 页面组织器 / 任务队列 / 设置             │
│  选项表单由 core 里的字段 schema 驱动，一份定义两端复用         │
└──────────────────────────────────────────────────────────────┘
```

- `packages/core` 是唯一协议来源：`ToolDescriptor` + `ToolField` schema 同时驱动 UI 表单渲染和引擎参数校验。工具目录描述任务归属、操作类型、支持的输入与输出格式；首页用单层任务导航浏览，并依据实际能力生成格式筛选。后续新增其他常用工具时，按具体用户任务纳入目录。
- 桌面模式用 **路径** 传文件（零拷贝）；浏览器模式没有磁盘权限，自动降级为 **base64** 传输，因此同一套 UI 在两种宿主里都能跑。
- 产物一律先写入临时目录（`$TMPDIR/potools/jobs/<jobId>/`），设置了输出目录时再复制一份过去，所以「另存为 / 重新保存」不会丢历史。

## 2. 已实现工具（42 个）

| 工具 | 能力 | 关键实现 |
| --- | --- | --- |
| 合并 PDF | 多文件顺序合并、统一页面尺寸/方向/边距 | pdf-lib `copyPages` + `embedPage/drawPage` 等比缩放（不裁切） |
| 拆分 PDF | 每页 / 每 N 页 / 页码范围 / 平均两份 / **可视化选点** | 缩略图流 + 页间切割点（点击增删、拖拽移动），实时预览分组 |
| 组织页面 | 缩略图拖拽排序、旋转、复制、删除、跨文件混排 | 交互式页面计划 `plan[{fileId,page,rotation}]` |
| 旋转页面 | 顺/逆时针、翻转，可指定页 | 写 `/Rotate`，不改动内容流 |
| 提取页面 | 按页码提取，可每段一个文件 | — |
| 删除页面 | 按页码删除，拒绝删空 | — |
| 删除空白页 | 自动识别并删除空白页，可"只报告" | 36DPI 光栅化后统计有墨像素占比 |
| 调整页面尺寸 | A4/A5/Letter/跟随首页/按百分比 | 与合并共用 `appendScaledPage` 缩放原语 |
| 页面裁剪 | 四边分别裁剪，或自动贴合内容再叠加边距 | MuPDF 低分辨率扫描求内容包围盒 → 改 `CropBox` |
| 添加页边距 | 四边/上下/左右白边，可选保持或放大页面 | 保持尺寸时收缩绘制区域即为白边 |
| 多页合一 | 2/4/6/9 合 1，横纵顺序、间距、边距、边框 | 预嵌入全部页面后按网格排版 |
| 发票合并 | 多张票据去重、自动裁白边后拼到 A4/A3/Letter（自动或 1/2/4/6 合 1） | MuPDF 求内容包围盒 → 以 `embedPage` 的 BBox 裁切，并把 `/Rotate` 折进表单矩阵后按货架式排版 |
| 水印 | 中文文字水印、字号/透明度/倾斜/9 宫格定位/平铺/上下图层 | 视觉坐标系反算 + 基线回推，旋转页同样对齐 |
| 页码 | `{n}/{total}` 自定义格式、起始值、边距、首页跳过 | 同上 |
| 页眉页脚 | 上下文本 + `{n}/{total}/{name}` 变量、左中右对齐 | 复用同一套文字排版 |
| 文档属性 | 读取导出 JSON / 写入字段 / 一键清除（含 XMP） | 直接操作 Catalog 与 Info 字典 |
| 压缩 PDF | 内嵌 JPEG 重采样重编码 + 对象流 + 清除元信息 | 原地替换图像流对象（pdf-lib 不回收孤儿对象） |
| 修复文档 | 重建交叉引用表，修复打不开的文件 | MuPDF 修复后回交 pdf-lib；无法恢复时明确报错 |
| PDF 转图片 | 每页导出 JPG / PNG / WebP，DPI 与质量可调 | MuPDF 光栅化 → sharp 转码 |
| 图片转 PDF | 尺寸/方向/摆放（完整·填满·原始）/边距/背景 | EXIF 方向、CMYK→sRGB、Alpha 保 PNG |
| 提取图片 | 导出内嵌图片原件或统一转格式，可按体积过滤 | 遍历间接对象识别 Image XObject |
| 提取文字 | 导出纯文本（合并或每页一个），可带页码标记 | MuPDF StructuredText |
| 图片压缩 | 批量调整质量、统一输出格式、可选限制最长边 | sharp 重编码，保留 EXIF 方向并报告体积变化 |
| 图片尺寸调整 | 按宽高缩放，支持完整包含、填充裁剪、拉伸和禁止放大 | sharp resize |
| 图片裁剪 | 以常用宽高比裁剪，支持居中及上下左右锚点 | 依据 EXIF 修正方向后提取裁剪区域 |
| 图片旋转与翻转 | 90°/180°/270° 旋转及水平、垂直翻转 | sharp 图像变换 |
| 图片格式转换 | 批量转换 JPG、PNG、WebP、TIFF | sharp 编解码 |
| 图片信息 | 批量读取像素尺寸、格式、通道、透明度与文件体积 | 导出 JSON 清单 |

附带能力：空口令加密文件自动解密后处理（MuPDF 中转）、损坏 PDF 自动修复重试、批量任务并发、任务取消、结果一键**保存到指定文件夹**、按平台的**默认输出目录**、**临时文件统计与清理**、中英文界面、明暗主题、文件名模板。

## 2b. 工作台界面

- 工具库按页面管理、页面版式、标注、转换、提取、优化、图片处理和文档信息等任务组浏览；每项工具只归属一个任务组。列表标出实际输入与输出方向，避免把“PDF 转 Word”和“Word 转 PDF”混为同一文件领域。
- 首页只保留一层任务导航与真实可用格式筛选；最近使用展示工具，任务队列单独展示运行状态。后续新增常用工具时按其实际任务归属加入工具库。
- 首页采用紧凑列表呈现工具用途和格式方向，避免重复卡片占据主要工作区。

- 组件层是 vendor 进来的 shadcn/ui（`src/components/ui/*`，Radix + CVA + tailwind-merge），`components/ui.tsx` 只做应用级组合：带图标/忙碌态的 Button、Section=Card、Segmented=Tabs、Toggle=Switch。shadcn 用到的语义色直接映射到既有 `--c-*` 调色板，换组件不改配色。
- 反馈统一走 sonner toast（保存成功/失败、临时目录清理结果），不再在卡片里塞一行临时文字。
- 标题栏由应用自绘（`components/TitleBar.tsx`）：整条都是拖拽区，中部分隔线后显示当前页面名，右侧是语言/主题下拉菜单。macOS 走 `titleBarStyle: Overlay + hiddenTitle`，红绿灯浮在自绘栏左侧预留的 78px 内（见 `tauri.macos.conf.json`）；Windows/Linux 用 `decorations: false`，在标题栏内自绘最小化/最大化/关闭（`src/lib/window.ts`）。浏览器模式下不渲染窗口按钮，其余布局一致。

## 3. 开始使用

前置：Node 20.19+ 或 22.12+、pnpm 12、Rust stable（`rustup default stable`）、macOS 需 Xcode Command Line Tools。

```bash
pnpm install

# 只跑浏览器版（引擎 HTTP 模式，用于快速调试 UI）
pnpm dev              # http://127.0.0.1:5199

# 桌面版（Rust 自动拉起 Node sidecar，走 stdio）
pnpm tauri dev

# 生成样例 PDF（供自测与手动验证）
pnpm samples
```

打包：`pnpm tauri build`（`beforeBuildCommand` 会先把引擎 bundle 到 `packages/engine/dist` 并作为 resource 一起装进安装包）。

## 4. 验证

```bash
pnpm test:tools        # 端到端检查：工具全覆盖 + 内容断言 + 格式往返 + 错误路径 + 临时清理
pnpm --filter @potools/engine typecheck
pnpm --filter @potools/desktop typecheck
pnpm tauri dev         # 桌面版：Rust 启动即拉起 Node sidecar
```

`scripts/run-tools.ts` 会真实调用引擎跑完每个工具，分四层：

1. **逐工具功能**：产物存在、页数正确、中文渲染；
2. **覆盖矩阵**：遍历工具注册表，用默认参数（organize 补 plan、按 accept 选样）各跑一遍，任何新工具漏测都会立刻显形；
3. **内容与往返**：读回产物 PDF 的 CropBox/MediaBox 尺寸与 `/Rotate`、MuPDF 反查文本，校验 docx/xlsx/pptx/epub/ofd 的 zip 结构，并做 PDF→docx→PDF、PDF→OFD→PDF 往返；
4. **错误路径**：空文件、页码越界、错格式输入（每种导入工具各一条）、Markdown 喂二进制、任务取消。

浏览器多视口审计：打开 `http://127.0.0.1:5199/ui-audit.html#/`，会在 1440/1180/1024/900/780 五个宽度下各渲染一个实例，并报告横向溢出、被裁切元素与溢出省略的文本。

已实测通过的关键链路：
- 引擎工具均产出正确文件；Office/OFD 产物用 JSZip 解包校验内部 XML 与页数，导入结果再用 MuPDF 反读文本核对；
- 发票合并：拼接后的票据经 MuPDF 回渲确认裁边与旋转（`/Rotate 90` 的横条在产物中竖放，实测 43×403 pt）；
- 压缩：9.3 MB 图片型 PDF → 380 KB（原地替换图像流，不产生孤儿对象）；
- 桌面：Rust 宿主 spawn `packages/engine` 的 Node 进程（`serve --stdio`），ndjson 握手 + `engine_write` 双向通信有日志佐证；
- 浏览器模式：上传→执行→进度事件→产物列表全链路走通（Vite 代理会缓冲 SSE，因此事件流直连引擎端口）。

## 5. 打包说明

- `src-tauri/.cargo/config.toml` 把 crates.io 换成了 `rsproxy.cn` 镜像（本机网络直连 crates.io 会卡死）。删掉该文件即回到官方源。
- Windows x64 安装包会从 Node.js 官方发布构建下载并校验 Node 22.20.0，随包启动引擎；macOS/Linux 仍使用系统 Node，可用 `POTOOLS_NODE` 指定路径。
- 引擎 bundle（`packages/engine/dist/engine.mjs`）刻意把 `sharp` 与 `mupdf` 留作外部依赖，因为它们是原生/WASM 包。当前安装包没有携带这两个模块，相关图片编解码和 PDF 光栅能力会返回明确错误（`error.noImageCodec` / `error.noRasterizer`，界面按 `hintKey` 翻译成中文提示）。开发模式用 `tsx` 直接跑源码，不受影响。

## 6. 设置项

设置页按标签分组（外观 / 输出 / 存储 / 高级 / 引擎 / 关于），可用 `#/settings?tab=engine` 直达某一页。

| 项 | 说明 |
| --- | --- |
| 默认输出目录 | 留空则结果留在临时目录，可逐条另存/下载 |
| 文件名模板 | `{name} {tool} {index} {i} {total} {range} {date} {time}`；同名不覆盖，自动追加 `(2)` |
| 并行任务数 | JobManager 并发度，默认 2 |
| 中文字体文件 | 用于嵌入 CJK 字形；留空自动探测（macOS 命中 `Arial Unicode.ttf`，Windows `msyh/simhei`，Linux `Noto CJK/wqy`） |
| 平台默认目录 | 引擎按平台给出：macOS/Linux `~/Documents/PoTools`（本地化目录名自适应）、Windows `%USERPROFILE%\Documents\PoTools`（有 OneDrive 时优先） |
| 临时目录保留天数 | 启动时自动清理更早的任务目录，0 表示不自动清理；存储页可随时查看占用并手动清理 |
| 引擎自检 | 中英文列出连接状态、运行方式、协议版本、PID、渲染/转码能力与中文字体探测结果 |

图标只有一份美术源：`apps/desktop/public/app-icon.svg`。`pnpm icons` 由它生成 favicon、apple-touch、应用内 LOGO 与 `src-tauri/icons/*`，桌面图标和界面 LOGO 因此不会走偏。

## 7. 已知边界

- **加密**：只处理空口令文件。带真实用户口令的 PDF 会明确报错，本版本不含解密。
- **压缩**：只重编码无透明通道的 8bit DeviceRGB/DeviceGray JPEG；带 SMask、JPX、CMYK、16bit 的图片会跳过并在结果里提示。
- **书签/表单/注释**：合并与组织页面不迁移大纲（书签），AcroForm 字段与注释不保证保留。
- **Office/OFD 转换是"可编辑近似版"**：纯 JS 实现，不依赖本机 LibreOffice。导出保留标题层级、列表、表格列位与图片位置，但母版、样式继承、SmartArt、批注、单元格公式不还原；导入按段落重排，不复刻 Word 的精确分页。
- **老二进制格式不支持**：`.doc/.xls/.ppt` 不是 zip 包，会直接报「请先另存为 docx/xlsx/pptx」。
- **PDF 转 OFD 的文字模式**：字体小于 3 MB 时整份嵌入，否则只登记字体名（打开的机器需装有该字体）；OFD 矢量路径（PathObject）暂不导出。
- **PDF 转图片类导出的图片**：MuPDF 的 structured text 在本 WASM 构建里不回报图片块，图片位置由内容流的 `cm ... Do` 反算，再从页面光栅中裁切；异常变换（旋转/斜切）下取包围盒。
- **未实现**：OCR、电子签名、文档对比、添加密码——这些依赖外部二进制或额外的安全处理实现，尚未纳入。
- 引擎以子进程方式运行；Windows x64 安装包自带 Node，macOS/Linux 桌面版需系统 Node，或通过 `POTOOLS_NODE` 指定路径。

## 8. 版权与许可

作者 / Author：**pohoc** · 邮箱：**po.hoc4@gmail.com**

本项目版权声明：`© 2026 pohoc. All rights reserved.`（已写入 `tauri.conf.json` 的 `bundle.copyright`、`Cargo.toml` 的 `authors` 与各 `package.json` 的 `author`，安装包的发布者信息同样取自这里）。

代码目前**尚未选择开源许可证**，默认保留所有权利。若要开源，需要先处理依赖授权：`pdf-lib`、`sharp`、`React`、`Tauri` 均为 MIT/Apache-2.0，可自由组合；但 **MuPDF 是 AGPL-3.0**（本工具用它做页面光栅化与损坏修复），一旦对外分发安装包就会触发 AGPL 的源码提供义务。可选路径：① 按 AGPL 开源；② 向 Artifex 购买商业授权；③ 把 MuPDF 换成 `pdfium`（Apache-2.0）或仅保留 pdf-lib 的降级渲染。确定方向后我再补 `LICENSE` 文件。
