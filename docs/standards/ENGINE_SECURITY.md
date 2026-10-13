# 引擎、安全和宿主边界规范（Engine & Security Standard）

**状态**：应遵守的安全底线与待整改设计，非“当前代码全部安全”的声明。受限于静态审查，本文件不证明漏洞已被实际利用。

## 1. 信任边界

```text
不可信：WebView JS、Worker 消息、用户输入、options、runtimeData、
        FileRef.path、文件名、归档相对路径、网络响应、目录设置
                ↓ 验证、限额、授权
可信边界：Tauri Rust 命令入口及其后端 PathGrants / OS 手势记录
                ↓
特权操作：读、写、复制、删除、文件浏览、启动外部程序、网络探测
```

- **前端校验不是授权**：任何 `invoke()` 都应假定可被恶意注入脚本调用；“设置项已经在 UI 展示”不足以证明前端传入的路径是用户主动同意的。
- **权限来源**：后端系统对话框结果、可信 OS 拖放、经过认证的应用管理目录。设置更改不能直接把任意自由路径变成全局读写 grant。
- **最小权限**：选中的单文件只授予该文件读权限，输出文件夹授予必要的写权限；来源目录读与目标目录写分别处理；禁止以写权限隐式换取整个目录读权限。
- **路径检查**：授权目录 canonicalize 后逐分量比较；拒绝相对路径和 traversal；写入需要安全创建和 symlink/reparse point 防护，校验与打开之间关注 TOCTOU。勿用字符串 `startsWith` 判断目录包含关系。
- **Native IPC**：所有命令都必须在 Rust 入口验证目标路径/来源权限，不能因为底层服务“只接受绝对路径”就省略授权。

## 2. 当前须优先整改的已知路径（Observed）

| IPC | 当前路径 | 目标门禁 |
| --- | --- | --- |
| `read_file_binary / read_file_bytes` | 已调用 `require_read` | 维持，补竞态测试 |
| `write_output_file / copy_staged_artifact` | 已调用 `require_write`（及来源读） | 维持，补拒绝/符号链接测试 |
| `invoice_scan_list` | 传入目录后直接扫描 | 来源必须有 `require_read` 目录 grant |
| `invoice_read_candidate` | 直接 `fs::read` 路径 | 必须拥有来源文件 / 目录读 grant |
| `invoice_archive` | 读取来源、在目标目录写入 | 来源读授权与目标写授权都必须由 Rust 验证 |
| `temp_clean / temp_usage` | 接收任意传入的根路径 | 只允许真实应用临时根目录 / 专属子目录，清理只应影响预期对象 |
| `set_output_dir / set_temp_dir` | IPC 可请求给指定目录 grant | 设置与授权分离，仅可信来源批准特权路径 |

代码参考：`apps/desktop/src/lib.rs`、`apps/desktop/src/access.rs`、`packages/engine/src/services/invoice/` 与 `services/temp.rs`。具体影响、证据与测试建议见 [问题登记](../audits/IMPLEMENTATION_GAPS.md)。

**注意**：这里的是「在脚本拥有 IPC 能力的前提下可能被滥用」的权限边界问题；不声称存在无需用户交互、从任意远程网页直接触发的漏洞。

## 3. 专用授权 API（Target）

建议在 Rust 命令入口统一封装：

```rust
// 示例接口，当前仓库尚未提供
fn require_source_file(grants: &PathGrants, path: &Path) -> Result<PathBuf, SecurityError>;
fn require_source_dir(grants: &PathGrants, path: &Path) -> Result<PathBuf, SecurityError>;
fn require_destination_dir(grants: &PathGrants, path: &Path) -> Result<PathBuf, SecurityError>;
fn require_app_temp_root(app: &AppHandle, path: &Path) -> Result<PathBuf, SecurityError>;
```

行为必须包含：身份和权限判断、目录范围限制、错误码一致性、符号链接校验、审计与单测。请勿为了通过 UI 测试而添加任何 JS 可无条件授予读权的接口。

## 4. 任务运行安全

- 每个任务以 `jobId` 标识，支持 cancellation token；Native 和 Worker 侧均有取消传播，取消后不允许写出新的正式产物。
- 实施分层限额：单文件大小、解压后对象/像素/页数、批次总数据量、运行时间、CPU/内存、文件句柄、并发。
- OCR/图像/PDF 处理大量不可信字节，失败和 panic 应转成结构化 `EngineError`；不能把堆栈和敏感内容直接放到用户可复制日志。
- 大文件避免在 JS 与 Rust 双侧重复保留字节；数据在 Worker 传输时使用 transferable，文件产物优先临时 staging 和受控复制。
- 文件名、相对路径、PDF/OFD/EPUB/ZIP 内条目必须避免目录穿越、绝对路径与链接逃逸；对解压炸弹和巨大对象启用预算。
- 对部分成功的操作返回已完成产物与失败项，不得将“取消”伪装成“成功”。

## 5. 网络、密钥、日志与隐私

- 网络访问单独声明目标 host、发送的数据类别、超时及错误状态；Web `fetch` 必须与 Tauri CSP 一致，Native 网络服务由明确的调用权限限制。
- 不将文档内容、密码、密钥、Token、TOTP secret 和私密路径加入遥测或持久日志；错误报告需要脱敏，但不能假定正则替换就是完全匿名化。
- 密码学工具区分“解析、编码、加密、签名、校验”，不得用“解码成功”暗示可信性。
- 对浏览器同源/Win7 Electron EOL 风险保持单独威胁模型；旧系统发行包不得宣传与受支持桌面宿主同等级别的系统安全。
- CSP、Tauri capability、自动更新密钥和签名应在 **最终打包应用** 中验证；CI 中仅编译通过不代表最终策略生效。

## 6. 权限回归测试最低集合

1. 未授予来源目录时，发票枚举和按绝对路径读取必须被拒绝。
2. 未授予目标目录时，发票归档、文件输出必须被拒绝；拒绝后原文件不变化。
3. 恶意 `../`、符号链接、目录替换、UNIX/Windows 根路径与 UNC 情况可预测地拒绝。
4. 临时清理永不访问应用根目录之外的 `jobs/inbox`，不可删除由攻击者自选根目录下的内容。
5. 非法 Job ID、嵌套文件名、极大文件、巨大解压对象、损坏 PDF 应有受控错误。
6. Native 任务执行中取消后最终目录无新输出；迟到进度/结果不能覆盖取消态。
7. 网络调用实际包体内可用；失败和超时具有明确诊断；默认离线能力不触网。
