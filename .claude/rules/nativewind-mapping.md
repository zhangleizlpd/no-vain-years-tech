---
paths:
  - 'apps/mobile/src/**'
---

# NativeWind 映射规则（path-triggered，改 apps/mobile/src/ 时自动加载）

UI/UX 设计意图 → NativeWind className 翻译规则。

> **底座**：NativeWind v4 + Tailwind + mono inline tokens（per [ADR-0030](../../docs/adr/0030-package-decomposition.md) "5 包减 2"，原 `packages/design-tokens/` 已内联到 `apps/mobile/src/theme/`，被 `apps/mobile/tailwind.config.ts` import）。token 命名走 Tailwind 标准（`brand-500` / `spacing.md` / `text-base` 等）。

## 强约束（必遵循）

### 1. 视觉值走 Tailwind class，禁字面量

所有视觉值一律走 Tailwind class，**禁** inline 字面量（`style={{padding:16}}` / hex / rgb / `8px`）。token 不够 → 改 `apps/mobile/src/theme/` 对应模块，**不**在业务代码 magic number / hex：

| 类别 | class                                           | 缺 token 改                                    |
| ---- | ----------------------------------------------- | ---------------------------------------------- |
| 间距 | `p-*` / `m-*` / `gap-{xs\|sm\|md\|lg\|xl\|2xl}` | `theme/spacing.ts`                             |
| 颜色 | `bg-brand-500` / `text-text` / `border-border`  | `theme/colors.ts`（danger/warning/success 等） |
| 字号 | `text-{xs\|sm\|base\|lg\|xl\|2xl\|3xl}`         | `theme/typography.ts`                          |
| 圆角 | `rounded-{sm\|md\|lg\|full}`                    | `theme/`                                       |
| 阴影 | `shadow-{sm\|md\|lg}`                           | `theme/`                                       |

```tsx
// ✅ 正确
<View className="gap-md p-lg" />
<Pressable className="bg-brand-500" />
<Text className="text-text" />

// ❌ 错误
<View style={{ gap: 16, padding: 24 }} />
<Pressable style={{ backgroundColor: '#3B82F6' }} />
```

### 2. className 不超 4 个原子（per element）

- 单 component 的 className 不超 4 个 utility class；超过 → 抽 styled component 到 `apps/mobile/src/ui/`
- 复用频次 ≥ 2 → 必须抽组件

```tsx
// ✅ 复用频次 ≥ 2，抽 apps/mobile/src/ui/Button.tsx
import { Button } from '@/ui';
<Button variant="primary" size="md">登录</Button>

// ⚠️ 单次使用，4 个原子内可接受
<View className="flex-row items-center gap-sm" />

// ❌ 超过 4 个原子 + 复用 → 抽组件
<Pressable className="flex-row items-center gap-sm bg-brand-500 px-lg py-md rounded-md shadow-md" />
```

### 3. RN-Web 兼容写法

- **禁用** `rounded-[50%]`（RN-Web 报警告，用 `rounded-full` 或 `rounded-[9999px]`）
- **禁用** 百分比 borderWidth（RN 不支持）
- web 专属样式（hover / focus-visible）用 `web:` 前缀（NativeWind v4 平台 modifier）；native-only 用 `native:`
- 字体走 `theme/typography.ts` 的 `fontFamily.body` / `heading` / `mono` token，避免业务代码写具体字体名

## 推荐（强烈鼓励）

### 4. 复用既有组件优先

- 写新页面前，先 grep `apps/mobile/src/ui/` 看有无现成组件（`Button` / `SafeAreaView` / `Spinner` 等）
- 90% 业务页面应由现有原语组合而成（如 `<Button>` `<PhoneInput>` / `<SmsInput>` / `<DisplayNameInput>` `<ErrorRow>` `<SafeAreaView>` `<Switch>`）；通用容器原语随需要在 `ui/` 新增，勿假设 `Form` / `Card` 已存在
- mono 出现多 frontend consumer → 触发 [ADR-0030](../../docs/adr/0030-package-decomposition.md) sunset，从 `src/{theme,ui}/` 抽回 `packages/`

### 5. 状态机化处理 loading / error

- 任何含异步调用的 component 必须有 4 个状态：`idle | loading | success | error`
- loading 用 disabled button + `<Spinner>`；error 用 `<ErrorRow>`（`apps/mobile/src/ui`）+ `xxxErrorToast(error): string` 文案映射（error→string，见各 feature `use-*-form.ts`）—— `ui/` 无通用 `Toast` 组件

### 6. a11y 不省

- 所有交互 component 必须有 `accessibilityLabel`
- form 的 label / input 配对必须正确
- tab 顺序合理（`accessibilityRole` + `tabIndex`）

## 反模式（CR 时必驳回）

- ❌ 复制粘贴 styled component 到 features/ 内（应在 `apps/mobile/src/ui/` 抽公共）
- ❌ 业务代码混用 className + `StyleSheet.create` / `style` prop（除非 className 表达不出来，如动态计算位移）
- ❌ 业务代码内写 platform-specific style 分支（用 `.web.tsx` / `.native.tsx` 后缀 或 `web:` / `native:` modifier）
