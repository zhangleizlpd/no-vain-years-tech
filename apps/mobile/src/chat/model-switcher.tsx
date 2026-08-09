// 029 T008 — 顶栏模型选择器（翻 mockup design/model-switcher.dc.html 4 frame）。
//
// 拆两件（受控 open 态由 chat-home-screen 持有，与 028 抽屉同范式：屏级持开关态）：
//   ① ModelSwitcherTrigger —— 顶栏中部模型名 Pressable（tap 开下拉，chevron 旋转 +
//      brand-soft 底 active）。放进顶栏 space-between 布局，随顶栏流式排布。
//   ② ModelDropdown —— 下拉 overlay。**渲在屏级**（flex-1 bg-surface 直接子，与顶栏同级），
//      故 absolute inset-0 锚到整屏：遮罩可覆盖顶栏 + 消息区，tap 任意空白处关。卡片置于
//      顶栏正下方（top 偏移），内含「选择模型」标题 + flash/pro 行 + 分隔 + MiniMax 留位。
//
// 为何拆开（而非 028 抽屉那样自含 overlay）：模型名 trigger 必须落在顶栏 space-between
// 三栏布局里（hamburger / 模型名 / 新建），但其下拉浮层要覆盖整屏（遮罩 tap 关）——顶栏
// 容器仅 52px 高，inset-0 锚它只盖 52px。故 trigger 留顶栏、overlay 提到屏级（覆盖全屏）。
//
// 数据源 = use-models（GET /chat/models + 端点失败降级内置默认，FR-012）。available 透传：
//   可用项（flash/pro/minimax）可选、当前所选 brand ✓ 对勾（FR-002）；留位项（available:false，
//   若有）disabled「即将上线」pill，tap 无副作用（onPress 不挂，FR-005 / state_branch #7）。
//
// 开关 tap 驱动（顶栏 tap 开 / 遮罩 tap 关 / 选项 tap 关，per RNGH web 手势非确定 memory）；
// 每个可交互元素带 testID/a11y label 供 T009 e2e 驱动。presentational —— 无 vitest。
import { useCallback } from 'react';
import { Pressable, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { colors } from '~/theme';
import { CHAT_COPY, CHAT_MODEL_NAME } from './chat-copy';
import { useModels } from './use-models';
import type { ChatModel } from './use-chat';

/** 可作切换目标的逻辑 model 集（与 server SetConversationModelRequestModel 一致）。 */
const SWITCHABLE: ReadonlySet<string> = new Set<ChatModel>(['flash', 'pro', 'minimax']);

// ─────────────────────────── 顶栏 trigger（放顶栏 space-between 布局） ───────────────────────────

export interface ModelSwitcherTriggerProps {
  /** 当前会话所用逻辑模型（顶栏展示，FR-007）。 */
  model: ChatModel;
  /** 下拉是否展开（受控，屏级持有）。 */
  open: boolean;
  /** tap 切换下拉开关。 */
  onToggle: () => void;
}

/** 顶栏中部模型名按钮（tap 开/关下拉）。 */
export function ModelSwitcherTrigger({ model, open, onToggle }: ModelSwitcherTriggerProps) {
  return (
    <Pressable
      className={`flex-row items-center gap-1 rounded-full px-3 py-1.5 ${open ? 'bg-brand-soft' : ''}`}
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityLabel={CHAT_COPY.modelSwitcher}
      accessibilityState={{ expanded: open }}
      testID="chat-model-switcher-button"
    >
      <Text
        className={`text-lg font-medium ${open ? 'text-brand-500' : 'text-ink'}`}
        testID="chat-model-name"
      >
        {CHAT_MODEL_NAME[model]}
      </Text>
      <ChevronIcon up={open} active={open} />
    </Pressable>
  );
}

// ─────────────────────────── 下拉 overlay（渲在屏级，覆盖全屏） ───────────────────────────

export interface ModelDropdownProps {
  /** 当前会话所用逻辑模型（下拉打勾，FR-002/007）。 */
  model: ChatModel;
  /** 关下拉（遮罩 tap / 选项 tap 后调）。 */
  onClose: () => void;
  /** 切换会话模型（接 use-chat.setModel：流中先 abort + 内存态 + 已落库则持久化）。 */
  onSelect: (next: ChatModel) => void;
}

/** 模型下拉浮层（遮罩 + 卡片）。open 时由屏级条件渲染挂载（关态不挂、不挡底层交互）。 */
export function ModelDropdown({ model, onClose, onSelect }: ModelDropdownProps) {
  const { models } = useModels();

  const onPick = useCallback(
    (id: string) => {
      // 仅可切换集（flash/pro）触发切换；留位项不可达此（disabled 无 onPress）。
      // 同 model 由 use-chat.setModel 内部判等早返（不重复 PATCH，state_branch #4）。
      if (SWITCHABLE.has(id)) onSelect(id as ChatModel);
      onClose();
    },
    [onSelect, onClose],
  );

  return (
    <View className="absolute inset-0 z-20" testID="chat-model-dropdown-overlay">
      {/* 极浅遮罩：tap 关，无副作用（点外侧关）。 */}
      <Pressable
        className="absolute inset-0 bg-black/30"
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="关闭模型下拉"
        testID="chat-model-dropdown-backdrop"
      />

      {/* 卡片下拉（顶栏正下方居中）。 */}
      <View
        className="absolute left-[11%] right-[11%] top-12 rounded-2xl border border-line bg-surface p-1.5"
        style={{
          // 浮层投影非 Tailwind token 可表达（自绘 popover 一次性），用 inline shadow。
          shadowColor: '#111827',
          shadowOpacity: 0.18,
          shadowRadius: 22,
          shadowOffset: { width: 0, height: 12 },
          elevation: 12,
        }}
        testID="chat-model-dropdown"
      >
        <Text className="px-3 pb-1.5 pt-2.5 text-xs text-ink-muted">
          {CHAT_COPY.modelPickerTitle}
        </Text>

        {models.map((m) => (
          <ModelRow
            key={m.id}
            id={m.id}
            label={m.label}
            description={m.description}
            available={m.available}
            selected={m.id === model}
            onPick={onPick}
          />
        ))}
      </View>
    </View>
  );
}

// ─────────────────────────────── 下拉行 ───────────────────────────────

function ModelRow({
  id,
  label,
  description,
  available,
  selected,
  onPick,
}: {
  id: string;
  label: string;
  description: string;
  available: boolean;
  selected: boolean;
  onPick: (id: string) => void;
}) {
  return (
    <Pressable
      className={`flex-row items-center gap-3 rounded-xl px-3 py-3 ${selected ? 'bg-brand-soft' : ''}`}
      onPress={available ? () => onPick(id) : undefined}
      disabled={!available}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected, disabled: !available }}
      testID={`chat-model-option-${id}`}
    >
      <View className="flex-1">
        <View className="flex-row items-center gap-2">
          <Text className={`text-base font-medium ${available ? 'text-ink' : 'text-ink-subtle'}`}>
            {label}
          </Text>
          {!available ? (
            <Text
              className="rounded-full border border-line px-2 py-0.5 text-xs text-ink-subtle"
              testID={`chat-model-coming-soon-${id}`}
            >
              {CHAT_COPY.modelComingSoon}
            </Text>
          ) : null}
        </View>
        <Text className={`text-xs ${available ? 'text-ink-muted' : 'text-ink-subtle'} mt-0.5`}>
          {description}
        </Text>
      </View>

      {/* 当前所选打勾（brand ✓，FR-002）。 */}
      {selected ? <CheckIcon testID={`chat-model-check-${id}`} /> : <View className="w-5" />}
    </Pressable>
  );
}

// ─────────────────────────── icons（屏内一次性，不抽 ~/ui） ───────────────────────────

function ChevronIcon({ up, active }: { up: boolean; active: boolean }) {
  return (
    <Svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={active ? colors.brand[500] : colors.ink.subtle}
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ transform: [{ rotate: up ? '180deg' : '0deg' }] }}
    >
      <Path d="M6 9l6 6 6-6" />
    </Svg>
  );
}

function CheckIcon({ testID }: { testID: string }) {
  return (
    <Svg
      width={20}
      height={20}
      viewBox="0 0 24 24"
      fill="none"
      stroke={colors.brand[500]}
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      testID={testID}
    >
      <Path d="M5 12.5l4.5 4.5L19 7" />
    </Svg>
  );
}
