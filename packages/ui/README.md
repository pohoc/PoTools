# @potools/ui

PoTools 的共享 React UI 基础包。它只负责可复用的视觉语言、基础组件和无业务状态的组合组件；页面、路由、i18n、文件处理和桌面/Tauri 适配留在应用层。

## 分层规范

- `src/theme/styles.css`：全局 token、基础 reset、可访问性和通用状态样式。
- `src/components/ui/`：无业务基础组件，组件只接收 props，不读取桌面 store。
- `src/components/ui.tsx`：应用无关的组合组件，如 `Button`、`Section`、`EmptyState`、`Segmented`。
- `src/components/Icon.tsx`：统一图标语义映射。
- `src/index.ts`：唯一公共入口；消费者不得依赖 `src` 内部文件。

## 主题约定

组件只使用语义 token（`canvas`、`surface`、`raised`、`line`、`ink`、`muted`、`faint`、`accent`、`ok`、`warn`、`bad`），禁止在组件内写产品页面专用颜色。暗色主题通过 `.dark` 切换，交互焦点必须保留可见轮廓，动画必须尊重 `prefers-reduced-motion`。

形状和空间也遵循 token：输入框、按钮等控件使用 `--ui-radius-control`；卡片使用 `--ui-radius-card`；弹层使用 `--ui-radius-overlay`；状态徽章和标签使用 `--ui-radius-pill`。不要在组件中新增随意的 `rounded-[...]`、阴影或间距值，确有例外时应在主题 token 层登记。

### Token 分层

`tokens.css` 是唯一的设计决策来源，按以下顺序使用：

1. 语义颜色：`canvas` 页面底色、`surface` 内容面、`raised` 次级容器、`line` 分隔线、`ink/muted/faint` 文本层级。
2. 交互颜色：`accent` 主操作、`accent-soft` 次级强调；`ok/warn/bad` 只表达状态，不用于品牌主操作。
3. 几何与空间：控件使用 `radius-control` 和 `control-sm/md/lg`，卡片和弹层分别使用 `radius-card/overlay`，布局间距使用 `space-*`。
4. 反馈：焦点使用 `focus-ring`，禁用使用 `disabled-opacity`，动画使用 `motion-*` 并服从 reduced motion。

`--ui-*` 是唯一的 token 命名空间（`--c-*` 兼容别名已移除）。HeroUI 的语义变量由 `styles.css` 映射到同一组 `--ui-*` token，不能再创建第二套颜色或圆角体系。样式基于 Tailwind v4 `@theme`；消费者不得再挂载 legacy `tailwind.config.js`，应用专属扩展（如布局尺寸）在消费端的 `@theme` 块里登记。

### 组件实现边界

- HeroUI 负责可访问行为、键盘交互、浮层定位和组件语义；`@potools/ui` 负责包装、默认尺寸和视觉 token。
- 页面不应直接从 `@heroui/react` 导入核心控件，也不应复制 `packages/ui/src/components`。
- Button 的 `primary/default` 是主操作，`secondary/outline` 是次操作，`ghost/quiet/link` 只用于低强调操作，`danger` 仅用于破坏性操作。
- 表单控件统一使用 `surface` 背景、`line` 边框、`accent` 焦点环；不得通过页面 class 单独改成纯白、纯黑或蓝色。
- Tooltip 只补充图标按钮、截断文案和非显而易见状态，不重复已经可见的说明文字。

### 质量门槛

提交前至少执行：

```sh
./node_modules/.bin/tsc -p packages/ui/tsconfig.json --noEmit --pretty false
git diff --check -- packages/ui
```

新增组件需要同时检查浅色/深色、hover/focus/disabled、键盘操作和 `prefers-reduced-motion`；如果组件存在表单语义，还要检查 label、错误信息和 `aria-describedby` 链路。

## 消费方式

```tsx
import '@potools/ui/theme.css';
import { Button, Card } from '@potools/ui';
```

适配桌面端时统一从 `@potools/ui` 导入，禁止重新复制组件或绕过公共入口。`toast`（sonner）与 `cn` 也从包入口导出，应用不得直接依赖 `sonner`、`clsx`、`tailwind-merge`、`lucide-react` 等底层库；图标一律通过 `Icon` 的语义名使用，新增图标先登记到 `Icon.tsx` 的映射表。

### 主题

`ThemeProvider` 默认自管持久化（localStorage）；宿主有自己的设置存储时传入 `mode` + `onModeChange` 切换为受控模式，持久化由宿主负责。首屏防闪烁由宿主在 React 挂载前手动镜像一次 `.dark` 类。

### 状态语义

`ProgressBar`（`tone: accent/ok/bad/idle` + `striped`）与 `StateBadge`（`tone: accent/ok/bad/muted` + `icon` + 文案）只认语义 tone；业务状态枚举（如任务队列的 `queued/running/...`）到 tone 与文案的映射由应用层完成。

## 表单约定

优先使用 `FormField`、`FormLabel`、`FormControl`、`FormDescription` 和 `FormMessage` 组合字段。`FormControl` 会自动补齐控件 ID 以及 `aria-invalid`、`aria-describedby`；业务侧只需要传递校验状态和错误文本。

受控组件使用 `value` 与回调，非受控组件使用 `defaultValue`。不要同时传递两套状态来源。文件上传统一通过 `FileUpload` 的 `onFiles` 返回 `File[]`，业务层负责校验大小、类型和上传策略。

## 日期时间约定

- 单值：`DatePicker`、`TimePicker`、`DateTimePicker`、`MonthPicker`
- 范围：`DateRangePicker`、`TimeRangePicker`、`DateTimeRangePicker`
- 时长：`DurationInput`，值统一使用秒数

日期时间组件使用浏览器原生值格式：日期为 `YYYY-MM-DD`，时间为 `HH:mm`，本地日期时间为 `YYYY-MM-DDTHH:mm`。不要在 UI 组件内进行时区转换；时区转换和展示格式属于业务/领域层职责。
