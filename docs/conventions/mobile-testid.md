# Mobile testID 命名 convention

> 体例源于在用代码：Playwright e2e 用 `getByTestId` 消费。Maestro 未落地（仓内零 flow）；它来了也用同一串 id（`tapOn: { id }`），永不需要第二套体例。决策与「原生 flow 何时写」见 [ADR-0027 § Consequences](../adr/0027-frontend-data-test-layer.md)。

## 格式

```text
testID="<feature>-<element>[-<state>]"
```

| 字段      | 取值                                       | 说明                                                                      |
| --------- | ------------------------------------------ | ------------------------------------------------------------------------- |
| `feature` | 所属 feature / module 目录名（kebab-case） | 与 `apps/mobile/src/<feature>/` 一致，如 `optionsdesk` / `alert` / `chat` |
| `element` | UI 元素（kebab-case，可多段）              | `radar-list` / `submit-button` / `phone-input`                            |
| `state`   | 可选状态后缀                               | `-loading` / `-empty` / `-error`；动态生成走模板 `${testID}-<state>`      |

不写动词段（`.tap` / `.type`）：动作由测试侧表达，id 只标识元素。仓内真实样本：`testID="chat-copy-button"`、`testID="chain-report-loading"`；全量自证 `grep -rhoE 'testID="[^"]+"' apps/mobile/src apps/mobile/app | sort -u`。

## 落地范围

- **交互元素**（`Pressable` / `TextInput` / 任何带 `onPress` / `onChangeText` 的组件）必带；e2e 定位一律 `getByTestId`，**不按文案 / class 定位**（copy 与样式会变，id 不变）。
- 状态变体（loading / empty / error）用 state 后缀，**不换 id**。
- 纯展示元素（`Text` / `View` / `Image`）与 dev-only 组件不强制。

## 检验

- 机器：无独立 lint；Playwright `getByTestId` 找不到即红是唯一闸（`.claude/rules/mobile-e2e-hermetic.md` 写 e2e 时自动装载本约定指针）。
- 体例变更时机：仓内出现第一条 Maestro flow（YAML）时评估是否需调整；在那之前本体例即全部规则。
