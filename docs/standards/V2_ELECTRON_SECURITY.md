# V2 Electron / Node 安全规范

V1 的安全整改是最低基线，不能因重写倒退。

1. 所有 renderer 启用 `contextIsolation:true`、`sandbox:true`、`nodeIntegration:false`；preload 只暴露最小语义 IPC allowlist，禁止转交原始 `ipcRenderer`、任意 `invoke`、Node fs/shell。CSP、导航/弹窗/外链严格限制。
2. 每个主进程 IPC handler 验证 sender/window/origin、Schema、权限、路径与预算。选取输入文件只读；写入必须来自可信保存对话框或用途限定授权；前端路径参数不能新增权限。
3. 处理恶意 PDF/OFD/图片/ZIP 的耗时任务置于独立 Worker/utility process，设置单文件、批次、像素、页数、解压后字节、CPU/内存、时间和并发上限。主进程不能阻塞。
4. 文件路径严格防 `..`、symlink、同前缀绕过、TOCTOU、UNC、Zip Slip；输出先暂存，发布前再次检查授权与取消，默认不覆盖输入，可回滚归档/撤销。
5. 网络工具标记目标、发送内容、超时和并发；除明确联网工具外文档本地处理。日志、报错和诊断导出必须脱敏；不持久化秘密或用户正文。
6. 打包版验证签名更新、CSP、offline OCR/字体/Worker 与权限；不能用 `pnpm dev` 成功代替真实发行包安全测试。

必须有直接 IPC 伪造/未授权调用、目录逃逸、恶意归档、取消后无最终写入、敏感日志、失败恢复和更新回退的自动回归。
