// 032 T013 — 中央 + FAB 创建浮层（翻面 A，root RN Modal）。
//
// 🚨 盖 tab 栏唯一正确层 = root RN `Modal`（per reference_drawer_overlay_bounded_by_tab_content_use_modal：
// 渲在 tab 屏内的 absolute overlay 够不到同级 Tab 栏）。FAB 本体由 (tabs)/_layout 的根层
// absolute 叠加渲染（不覆写 tab 栏高度）；本组件 = FAB 点开后的浮层（grid → 标题输入两态）。
//
// 视觉承 create-fab-overlay mockup（0 新 token，per design Decision note）：
//   - scrim .48 = bg-modal-overlay（复用既有 token）
//   - 锚定面板从 + 正上方长出 + 底边指向三角（→ 绿 FAB）；非 bottom-sheet
//   - 活入口「prd灵感」brand-soft 高亮 +「可用」角标居首；其余 7 置灰 ghost（不命名）
//   - 点 prd灵感 → 切标题输入：单行框（聚焦 brand 描边）+「新建」主按钮（无三角，贴键盘上方）
//
// ⚠️ 锚定面板的 bottom 偏移 / 指向三角是相对 tab 栏（49 + insets.bottom）的动态位移，
// className 表达不出 → 用 style（per nativewind rule「动态计算位移」例外）。
import { useCallback, useState } from 'react';
import { Controller } from 'react-hook-form';
import { Modal, Pressable, Text, TextInput, View } from 'react-native';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { tokens } from '~/theme';
import { ErrorRow, Spinner } from '~/ui';
import { IDEATION_COPY } from './ideation-copy';
import { ideationSessionRoute } from './ideation-routes';
import { useCreateSessionForm } from './use-create-session-form';

const TAB_BAR_BASE_HEIGHT = 49; // React Navigation v7 bottom-tabs 平台常量（不覆写）。
const FUTURE_SLOT_COUNT = 7; // 活入口 prd灵感 + 7 置灰槽位 = 2×4 grid（mockup）。
const CARET_SIZE = 16; // 指向三角边长（dp）；marginLeft 取 -CARET_SIZE/2 居中到锚点。

export interface CreateOverlayProps {
  visible: boolean;
  onClose: () => void;
  /** FAB 横向位置百分比（(tabs)/_layout 的 fabLeftPct）；menu 态指向三角尖底对齐到它。 */
  anchorLeftPct: number;
}

/** 内部子态：菜单网格 → 选 prd灵感 后切标题输入。 */
type Phase = 'menu' | 'title';

export function CreateOverlay({ visible, onClose, anchorLeftPct }: CreateOverlayProps) {
  const insets = useSafeAreaInsets();
  const [phase, setPhase] = useState<Phase>('menu');

  // 建会话成功 → 关浮层 + push 详情（导航单源在屏，hook 不导航，铁律 2）。
  const { form, state, errorToast, submit, clearError, reset } = useCreateSessionForm((id) => {
    handleClose();
    router.push(ideationSessionRoute(id));
  });

  const handleClose = useCallback(() => {
    reset();
    setPhase('menu');
    onClose();
  }, [reset, onClose]);

  const submitting = state === 'submitting';
  // 面板底边贴 tab 栏上沿（指向三角朝下指向 + FAB）。
  const panelBottom = TAB_BAR_BASE_HEIGHT + insets.bottom + 32;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={handleClose}>
      {/* scrim：tap 关（submitting 时锁） */}
      <Pressable
        onPress={submitting ? undefined : handleClose}
        accessibilityLabel={IDEATION_COPY.overlayBackdrop}
        className="flex-1 bg-modal-overlay"
      />
      {/* 锚定面板 = KeyboardStickyView「键盘配件」范式（官方）：库逐帧把内容跟随键盘平移，自身只定静置位。
          menu 态键盘未起 → 静置 bottom:panelBottom（贴 tab 栏上沿，原视觉）；title 态 autoFocus 弹键盘
          → 静置 bottom:0 + offset.opened=8 紧贴键盘上沿（不再自叠高 bottom 致悬空大缝）。 */}
      <KeyboardStickyView
        offset={{ closed: 0, opened: 8 }}
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: phase === 'menu' ? panelBottom : 0,
        }}
      >
        <View
          accessibilityLabel={IDEATION_COPY.overlayLabel}
          className="self-center bg-surface rounded-lg p-md shadow-modal"
          style={{ width: 304 }}
        >
          {phase === 'menu' ? (
            <MenuGrid onPickIdeation={() => setPhase('title')} />
          ) : (
            <TitleInput
              form={form}
              submitting={submitting}
              errorToast={errorToast}
              onSubmit={submit}
              onClearError={clearError}
            />
          )}
        </View>
        {/* 指向三角：仅 menu 态（新建态无三角）。镜像 FAB 自身定位法（left:`${pct}%` + marginLeft:-半宽）——
            与 FAB 同参照系（全宽 StickyView）、同单位、同百分比 → 各端 / 各 markets 态都跟 FAB 锁死对齐；
            作面板兄弟（不进 padded 面板）避开 RN %left+padding 偏移。 */}
        {phase === 'menu' ? (
          <View
            className="absolute bg-surface"
            style={{
              bottom: -CARET_SIZE / 2,
              width: CARET_SIZE,
              height: CARET_SIZE,
              left: `${anchorLeftPct}%`,
              marginLeft: -CARET_SIZE / 2,
              transform: [{ rotate: '45deg' }],
            }}
          />
        ) : null}
      </KeyboardStickyView>
    </Modal>
  );
}

/** 菜单网格：活入口 prd灵感 + 7 置灰未来槽位（不命名）。 */
function MenuGrid({ onPickIdeation }: { onPickIdeation: () => void }) {
  return (
    <View>
      <Text className="text-xs font-semibold text-ink-subtle mb-md">
        {IDEATION_COPY.overlayTitle}
      </Text>
      <View className="flex-row flex-wrap">
        {/* 活入口 · prd灵感 */}
        <Pressable
          onPress={onPickIdeation}
          accessibilityRole="button"
          accessibilityLabel={IDEATION_COPY.entryIdeationLabel}
          className="items-center gap-1.5 mb-md"
          style={{ width: '25%' }}
        >
          <View className="w-14 h-14 rounded-full bg-brand-soft items-center justify-center">
            <View className="absolute bg-brand-600 rounded-full px-1" style={{ top: -4, right: 8 }}>
              <Text className="text-white text-[8px] font-semibold">
                {IDEATION_COPY.entryAvailableBadge}
              </Text>
            </View>
            <Text className="text-brand-600 text-xl font-semibold">灵</Text>
          </View>
          <Text className="text-xs text-brand-600 font-semibold">
            {IDEATION_COPY.entryIdeationLabel}
          </Text>
        </Pressable>
        {/* 7 置灰未来槽位（不命名具体类型，PKM parked） */}
        {Array.from({ length: FUTURE_SLOT_COUNT }).map((_, i) => (
          <View
            key={i}
            accessibilityLabel={IDEATION_COPY.futureSlotLabel}
            className="items-center gap-1.5 mb-md"
            style={{ width: '25%' }}
          >
            <View className="w-14 h-14 rounded-full bg-surface-sunken" />
            <View className="rounded-full bg-line-soft" style={{ width: 26, height: 8 }} />
          </View>
        ))}
      </View>
    </View>
  );
}

/** 标题输入（点 prd灵感 后）：单行框 + 新建。RHF Controller（铁律 1）。 */
function TitleInput({
  form,
  submitting,
  errorToast,
  onSubmit,
  onClearError,
}: {
  form: ReturnType<typeof useCreateSessionForm>['form'];
  submitting: boolean;
  errorToast: string | null;
  onSubmit: () => void;
  onClearError: () => void;
}) {
  return (
    <View>
      <View className="flex-row items-center gap-sm mb-md">
        <View className="w-7 h-7 rounded-sm bg-brand-soft items-center justify-center">
          <Text className="text-brand-600 text-sm font-semibold">灵</Text>
        </View>
        <Text className="text-base font-semibold text-ink">{IDEATION_COPY.titleInputHeading}</Text>
        <Text className="text-xs text-ink-subtle ml-auto">{IDEATION_COPY.titleInputSubtitle}</Text>
      </View>
      {/* 铁律 1：Controller 包 TextInput（非 register）。 */}
      <Controller
        control={form.control}
        name="title"
        render={({ field: { value, onChange, onBlur } }) => (
          <TextInput
            value={value}
            onChangeText={(t) => {
              onChange(t);
              if (errorToast) onClearError();
            }}
            onBlur={onBlur}
            onSubmitEditing={onSubmit}
            editable={!submitting}
            autoFocus
            placeholder={IDEATION_COPY.titlePlaceholder}
            placeholderTextColor={tokens.colors.ink.subtle}
            accessibilityLabel={IDEATION_COPY.titleInputLabel}
            className="h-12 rounded-md border border-brand-500 px-md text-base text-ink"
          />
        )}
      />
      {errorToast ? <ErrorRow text={errorToast} /> : null}
      <Pressable
        onPress={onSubmit}
        disabled={submitting}
        accessibilityRole="button"
        accessibilityLabel={IDEATION_COPY.startCta}
        className="h-12 rounded-md bg-brand-600 items-center justify-center mt-md shadow-cta"
        style={{ opacity: submitting ? 0.6 : 1 }}
      >
        {submitting ? (
          <Spinner size={16} tone="white" />
        ) : (
          <Text className="text-base font-semibold text-white">{IDEATION_COPY.startCta}</Text>
        )}
      </Pressable>
    </View>
  );
}
