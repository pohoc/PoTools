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

## 消费方式

```tsx
import '@potools/ui/theme.css';
import { Button, Card } from '@potools/ui';
```

适配桌面端时统一从 `@potools/ui` 导入，禁止重新复制组件或绕过公共入口。

## 表单约定

优先使用 `FormField`、`FormLabel`、`FormControl`、`FormDescription` 和 `FormMessage` 组合字段。`FormControl` 会自动补齐控件 ID 以及 `aria-invalid`、`aria-describedby`；业务侧只需要传递校验状态和错误文本。

受控组件使用 `value` 与回调，非受控组件使用 `defaultValue`。不要同时传递两套状态来源。文件上传统一通过 `FileUpload` 的 `onFiles` 返回 `File[]`，业务层负责校验大小、类型和上传策略。

## 日期时间约定

- 单值：`DatePicker`、`TimePicker`、`DateTimePicker`、`MonthPicker`
- 范围：`DateRangePicker`、`TimeRangePicker`、`DateTimeRangePicker`
- 时长：`DurationInput`，值统一使用秒数

日期时间组件使用浏览器原生值格式：日期为 `YYYY-MM-DD`，时间为 `HH:mm`，本地日期时间为 `YYYY-MM-DDTHH:mm`。不要在 UI 组件内进行时区转换；时区转换和展示格式属于业务/领域层职责。
