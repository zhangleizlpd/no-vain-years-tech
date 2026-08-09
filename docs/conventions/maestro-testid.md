# Maestro testID 命名 convention

> testID 命名体例（备 [Plan 4](../adr/0025-frontend-cloudflare-pages-expo-web.md) binary 分发的 Maestro E2E；体例源 [ADR-0027 § Consequences](../adr/0027-frontend-data-test-layer.md)）。**Plan 4 前为休眠 forward spec——不强制回填**；真 forcing function = Plan 4 写 flow 时按 `state_branches` 逐分支补 testID、缺漏卡 flow（见 § 与 spec.md 的关联）。现存先行实例仅 `error-boundary.*`（2 段，pre-体例）。

## 格式

```text
testID="<feature>.<element>.<verb>"
```

| 字段      | 取值                                       | 说明                                                                   |
| --------- | ------------------------------------------ | ---------------------------------------------------------------------- |
| `feature` | spec.md frontmatter `feature_id` slug 部分 | e.g. `phone-sms-auth`（去掉 `NNN-` 前缀）、`account-profile`           |
| `element` | UI 元素类型（kebab-case）                  | `phone-input` / `sms-code-input` / `submit-button` / `tab-profile`     |
| `verb`    | 用户动作（kebab-case，单词数 ≤ 2；开放集） | 如 `tap` / `type` / `submit` / `edit` / `clear` / `select` / `dismiss` |

## 示例

| 场景                          | testID                                       |
| ----------------------------- | -------------------------------------------- |
| phone-sms-auth 手机号输入框   | `testID="phone-sms-auth.phone-input.type"`   |
| phone-sms-auth 验证码提交按钮 | `testID="phone-sms-auth.submit-button.tap"`  |
| account-profile 修改昵称按钮  | `testID="account-profile.display-name.edit"` |
| account-profile 退出登录      | `testID="account-profile.logout-button.tap"` |

## 落地范围（Plan 4 写 flow 时按本体例补；当前休眠不强制）

- **交互元素**：`<Pressable>` / `<TextInput>` / `<Button>` / `<TouchableOpacity>` / 等带 `onPress` / `onChangeText` 的组件
- **Final UI** 直翻 HTML → RN 时，已写的 testID 一同迁移（不丢失）

## 不强制范围

- 纯展示元素：`<Text>` / `<View>` / `<Image>` 等不响应用户输入的组件
- 仅在 dev tooling 中存在的组件（e.g. Expo Dev Tools 浮窗）

## 与 Maestro flow 的关系

- Plan 4 binary 分发开始时（per ADR-0027 sunset），Maestro flow YAML 用 `tapOn: { id: "phone-sms-auth.submit-button.tap" }` 引用
- Plan 4 前 flow 未写、testID 未回填（休眠 spec）；Plan 4 触发时随 flow 一并落地

## 检验机制

- **Plan 4 前**：无强制（休眠 spec）；现存 testID 仅 `error-boundary.*` 先行实例
- **Plan 4 起**：写 Maestro flow 时按 `state_branches` 逐分支引用 testID → 缺漏直接卡 flow（真 forcing function，见上）
- **可选加固**：若 Plan 4 落地中 testID 缺失反复，加 ESLint rule `react-native/no-untyped-testid-on-pressable`

## 与 spec.md 的关联

- spec.md `state_branches` 字段穷举状态机分支 → 每分支应有一个 Maestro flow（Plan 4 后）→ 每 flow 引用的 testID 必落到对应交互元素
- Plan 4 触发时按 `state_branches` × testID 1:N 关系写 flow，testID 缺漏直接卡 flow

## 参考

- [ADR-0027 Frontend Data + Test Layer](../adr/0027-frontend-data-test-layer.md) — Maestro 决策 + testID 强制时机
- [`docs/conventions/sdd.md` § 前端 UI 工作流](./sdd.md) — UI mockup-first 流程
- [Maestro 官方文档](https://maestro.mobile.dev/)
