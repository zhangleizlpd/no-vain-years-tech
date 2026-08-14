import { Pressable, Text, View } from 'react-native';

import { BACKSPACE } from './keypad.rules';

// 同花顺式自绘数字键盘（026 US1 / FR-003，mockup .keypad/.key/.ok 翻 RN）。
// 📌 053 T015 自 `alert/` 上提 `~/ui`（复用频次 ≥2：alert 参数 sheet + optionsdesk 检索条件
//    抽屉；两处都是「底部 sheet + 纯数字域」，系统键盘会把 sheet 顶出屏外）。
//
// 4×4 布局 = 左侧 3 列数字格（1-9 + 「.」/0/⌫）+ 右整列竖排「确定」。RN 无 CSS grid，
// 用 flexbox：键宽走 flex-1（行内三等分），**键高用固定 h-16（intrinsic 高度）**——
// 不能用 flex-1 撑行高：bottom-sheet 里键盘父容器无确定高度，flex-1(=flexBasis:0)会塌缩、
// 底部 0/./⌫ 行被挤出屏幕不可点（真机实证，web 视口够高漏测）。固定行高令键盘自带高度、
// sheet 自然容下。右「确定」列借默认 alignItems:'stretch' 等高对齐左网格。
// 纯展示：键值规范化（applyKey）/ 校验在调用屏，本组件只渲染键 + 透传 onKey/onConfirm。
// 交互·渲染·a11y 验证走 Playwright（T010），无 vitest（mono 测试分层：~/ui 与组件渲染不写单测）。
//
// 🚨 **右整列的次级键是加法式扩展**（056 T001 / FR-023）—— 本组件有**两个** consumer
//    （`alert/value-input-sheet.tsx` 原产地 + `optionsdesk/leg-criteria-sheet.tsx`），
//    省略 `secondaryLabel` / `onSecondary` 即今日行为（右列仍是单一确定键）。
//    🚫 MUST NOT 改成「恒两键」：`alert` 屏会多出一个它没有语义的按钮，而 **typecheck 全绿、
//    `alert` 现有 e2e 也全绿**（那些断言只看「确定」的可点 / 禁用态）⇒ 否定断言在
//    `e2e/alert-condition-ux.spec.ts`（右列按钮数恒 1），改坏了由它红。
//
// 注：plan 列的 `value` prop 未实现——keypad 只发按键、由父屏持有 raw 串并跑 applyKey，
// 传 value 进来会是未用 orphan，故省。

/** 4 行 × 3 列数字键面（末行 fn 键：小数点 / 退格，与设计基线 .key.fn 同语义）。 */
const ROWS: readonly (readonly string[])[] = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['.', '0', BACKSPACE],
];

/** 右整列容器的 testID —— 「右列有几个键」这条否定断言的锚（见文件头）。 */
const ACTIONS_TESTID = 'numeric-keypad-actions';

/** 按键无障碍读名（数字读自身；功能键给中文）。 */
function keyA11yLabel(key: string): string {
  if (key === '.') return '小数点';
  if (key === BACKSPACE) return '退格';
  return key;
}

/** 竖排文案：逐字成行（mockup `writing-mode:vertical-rl` 的 RN 等价）。 */
function VerticalLabel({ text, className }: { text: string; className: string }) {
  return (
    <>
      {text.split('').map((ch, i) => (
        <Text key={i} className={className}>
          {ch}
        </Text>
      ))}
    </>
  );
}

export interface NumericKeypadProps {
  /** 按键回调（数字字符 / '.' / BACKSPACE 原样透传，父屏跑 applyKey）。 */
  onKey: (key: string) => void;
  onConfirm: () => void;
  /** 值非法时禁用「确定」（FR-004，视觉 40% + 不可点）。 */
  confirmDisabled: boolean;
  /** 确定键文案（值类「确定」/ 组合类「确定」；纯周期类走 sheet「选好了」不用本键）。 */
  confirmLabel: string;
  /** 确定键的 testID（省略 = 不打标；e2e 按 `confirmLabel` 的 a11y 名定位亦可）。 */
  confirmTestID?: string;
  /** 次级键文案（**省略 = 右整列仍是单一确定键**，见文件头）。 */
  secondaryLabel?: string;
  /** 次级键回调。与 {@link NumericKeypadProps.secondaryLabel} 成对给，缺一即不渲染该键。 */
  onSecondary?: () => void;
  /** 次级键的 testID（省略 = 不打标）。 */
  secondaryTestID?: string;
}

export function NumericKeypad({
  onKey,
  onConfirm,
  confirmDisabled,
  confirmLabel,
  confirmTestID,
  secondaryLabel,
  onSecondary,
  secondaryTestID,
}: NumericKeypadProps) {
  // 成对给才渲染 —— 只给文案不给回调会渲出一个点了没反应的键（静默失败）。
  const hasSecondary = secondaryLabel !== undefined && onSecondary !== undefined;
  return (
    <View className="flex-row gap-sm bg-surface-sunken rounded-lg p-sm mt-md">
      <View className="flex-1 gap-sm">
        {ROWS.map((row, r) => (
          <View key={r} className="flex-row gap-sm">
            {row.map((key) => {
              const fn = key === '.' || key === BACKSPACE;
              return (
                <Pressable
                  key={key}
                  onPress={() => onKey(key)}
                  accessibilityRole="button"
                  accessibilityLabel={keyA11yLabel(key)}
                  className="flex-1 h-16 items-center justify-center bg-surface rounded-md"
                >
                  <Text
                    className={`font-mono font-semibold ${fn ? 'text-xl text-ink-muted' : 'text-2xl text-ink'}`}
                  >
                    {key}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ))}
      </View>
      {/* 📌 本列内部的 `flex-1` 是安全的：列高由左侧 4×`h-16` 网格经 alignItems:'stretch'
          决定，**是确定高度**；文件头禁的是「无确定高度父容器里裸 flex-1」。次级键固定高
          在上、确定键 flex-1 在下 ⇒ 两键体量明显不同（FR-022）。 */}
      <View className="w-3xl gap-sm" testID={ACTIONS_TESTID}>
        {hasSecondary ? (
          <Pressable
            onPress={onSecondary}
            accessibilityRole="button"
            accessibilityLabel={secondaryLabel}
            testID={secondaryTestID}
            className="h-14 items-center justify-center rounded-md border border-line"
          >
            <VerticalLabel text={secondaryLabel} className="text-sm text-ink" />
          </Pressable>
        ) : null}
        <Pressable
          onPress={onConfirm}
          disabled={confirmDisabled}
          accessibilityRole="button"
          accessibilityLabel={confirmLabel}
          accessibilityState={{ disabled: confirmDisabled }}
          testID={confirmTestID}
          className={`flex-1 items-center justify-center bg-brand-500 rounded-md ${
            confirmDisabled ? 'opacity-40' : ''
          }`}
        >
          <VerticalLabel text={confirmLabel} className="text-lg font-semibold text-white" />
        </Pressable>
      </View>
    </View>
  );
}
