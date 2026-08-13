// 052 T012 — 检索条件抽屉（FR-012/013, mockup `052-criteria-sheet.dc.html` 帧 A2/A3/A5/A6）。
//
// 🚨 **MUST 走 RN `Modal` 渲到 root 层** —— 抽屉渲在屏内时它的 absolute overlay 受
//    React Navigation 的 tab content 容器约束、**够不到同级 Tab 栏**（Tab 栏外露不被遮罩）。
//    同 `~/ui/app-drawer.tsx` 的范式，`statusBarTranslucent` / `navigationBarTranslucent`
//    让 Android 画到状态栏与导航栏之下。
//
// 🚨 **sheet 高度由内容撑开，MUST NOT 在无确定高度的容器里裸 `flex-1`** —— 后者的
//    `flexBasis:0` 会塌缩、把按钮挤出屏且不可点，而 Playwright Web 视口够高**照样全绿**
//    （mobile 布局铁律）。这里外层 `flex-1 justify-end` 只负责把 sheet 顶到底部。
//
// 🚨 **控件值全部来自服务端下发的 `defaults`**（FR-011）—— 本文件零处算式：
//    格式化 / 换算 / 比较全在 `leg-criteria.rules.ts`，这里只做接线与版面。
//
// 🚨 **ⓘ 是 tap 触发的 popup tip 不是 hover tooltip**（移动端没有 hover），且它只放**口径
//    说明**：判据本身（「或 Vol ≥」那支）做成常驻 OR 行 —— tooltip 易被忽略，把判据放进去
//    等于没写（NN/G）。热区 44×44，图标视觉 13px。
//
// 渲染 / 交互 / a11y 走 T013 Playwright e2e（本仓测试分层：vitest=logic / Playwright=UI）。
import { useState } from 'react';
import { Modal, Pressable, Text, TextInput, View } from 'react-native';

import { colors } from '~/theme';
import {
  changedCriteria,
  criteriaFormOf,
  criteriaRowsFor,
  normalizeCriteriaForm,
  sameCriteriaForm,
  type CriteriaForm,
  type CriteriaRowKey,
} from './leg-criteria.rules';
import { legTabLabel, type LegPickerTab } from './leg-picker.rules';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import type { RetrievalCriteriaResponse } from '@nvy/api-client';

const COPY = OPTIONSDESK_COPY.legPicker.criteria;

/** ⓘ 浮层相对该行顶边的落点（行高 32 + 4）—— 定位走 inline，视觉 token 仍走 class。 */
const TIP_TOP = 36;

export interface LegCriteriaSheetProps {
  /** 当前视角 —— 覆盖只作用于它（T010 裁定），标题与行集都跟着它走。 */
  tab: LegPickerTab;
  /** 该视角的**系统默认值**（服务端下发）。`null` = 契约未到手 ⇒ 六个框全空。 */
  defaults: RetrievalCriteriaResponse | null;
  /** 该视角**已提交**的覆盖值；`null` = 未覆盖 ⇒ 草稿从默认值起手。 */
  submitted: CriteriaForm | null;
  /** 「搜」—— 显式提交（FR-012 明禁输入停顿自动生效）。 */
  onSubmit: (form: CriteriaForm) => void;
  /** 「复位」—— 全部回系统默认值并重召回（FR-013）。 */
  onReset: () => void;
  onClose: () => void;
}

/**
 * 🚨 **本组件只在打开时挂载**（调用方 `{open ? <LegCriteriaSheet …/> : null}`）——
 * 草稿态因此随开关自然重建，不需要 effect 去同步；关掉再开就是一份新草稿（未提交的改动
 * 丢弃是**定义如此**：没点「搜」就等于没提交）。
 */
export function LegCriteriaSheet({
  tab,
  defaults,
  submitted,
  onSubmit,
  onReset,
  onClose,
}: LegCriteriaSheetProps) {
  const base = criteriaFormOf(defaults);
  const [draft, setDraft] = useState<CriteriaForm>(submitted ?? base);
  const [tipOpen, setTipOpen] = useState(false);

  const rows = criteriaRowsFor(tab, defaults);
  const changed = changedCriteria(draft, defaults);
  const pending = !sameCriteriaForm(draft, submitted ?? base);
  const set = (field: keyof CriteriaForm, value: string) =>
    setDraft((prev) => ({ ...prev, [field]: value }));

  const submit = () => {
    // 🚨 成对维度半空归零**改回表单本身**：框里留着一个 365 而生效的是「不限」，
    //    那个不一致在界面上无从解释（判据在 `normalizeCriteriaForm`）。
    const normalized = normalizeCriteriaForm(draft);
    setDraft(normalized);
    onSubmit(normalized);
  };

  return (
    <Modal
      visible
      transparent
      animationType="slide"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <View className="flex-1 justify-end bg-modal-overlay">
        {/* 遮罩 tap 关 —— 撑满剩余高度（sheet 之上的整片）。 */}
        <Pressable
          className="flex-1"
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={COPY.close}
          testID="optionsdesk-detail-criteria-backdrop"
        />
        <View
          className="gap-xs rounded-t-lg bg-surface px-md pb-md pt-sm shadow-sheet"
          testID="optionsdesk-detail-criteria-sheet"
        >
          <View className="items-center">
            <View className="h-1 w-9 rounded-full bg-line-strong" />
          </View>
          <View className="flex-row items-baseline justify-between pb-xs">
            <Text className="text-sm font-semibold text-ink">
              {COPY.sheetTitle(legTabLabel(tab))}
            </Text>
            <Text className="text-[10px] text-ink-muted" testID="optionsdesk-detail-criteria-sub">
              {sheetSubtitle(changed.length, pending)}
            </Text>
          </View>

          {rows.map((row) => (
            <CriteriaRow
              key={row}
              row={row}
              draft={draft}
              changed={changed}
              tipOpen={tipOpen}
              onToggleTip={() => setTipOpen((prev) => !prev)}
              onChange={set}
            />
          ))}

          {/* 「搜」与「复位」**并存** —— 不是 049 那种互斥槽位（FR-012 + FR-013 是两件事）。 */}
          <View className="flex-row justify-end gap-sm pt-sm">
            <Pressable
              onPress={onReset}
              accessibilityRole="button"
              accessibilityLabel={COPY.reset}
              testID="optionsdesk-detail-criteria-reset"
              className="rounded-full border border-line px-lg py-1.5"
            >
              <Text className="text-xs text-ink">{COPY.reset}</Text>
            </Pressable>
            <Pressable
              onPress={submit}
              accessibilityRole="button"
              accessibilityLabel={COPY.submit}
              testID="optionsdesk-detail-criteria-submit"
              className="rounded-full bg-brand-500 px-lg py-1.5"
            >
              <Text className="text-xs font-semibold text-white">{COPY.submit}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

/** 副标题三支：没动过 / 动了没提交 / 动了且已生效。 */
function sheetSubtitle(changedCount: number, pending: boolean): string {
  if (changedCount === 0) return COPY.subDefault;
  return pending ? COPY.subDirty(changedCount) : COPY.subApplied(changedCount);
}

/**
 * 一行控件。**一行 ≠ 一维**：行权价一行两个独立维度、DTE 与活性一行一个维度（值是一对数），
 * 判据见 `leg-criteria.rules.ts` 文件头。
 */
function CriteriaRow({
  row,
  draft,
  changed,
  tipOpen,
  onToggleTip,
  onChange,
}: {
  row: CriteriaRowKey;
  draft: CriteriaForm;
  changed: readonly string[];
  tipOpen: boolean;
  onToggleTip: () => void;
  onChange: (field: keyof CriteriaForm, value: string) => void;
}) {
  const dirty = (...keys: readonly string[]) => keys.some((key) => changed.includes(key));
  switch (row) {
    case 'strike':
      return (
        <View className="h-8 flex-row items-center gap-xs">
          <RowLabel text={COPY.labelStrike} dirty={dirty('strikeMin', 'strikeMax')} />
          <CriteriaInput field="strikeMin" label={COPY.labelStrike} draft={draft} set={onChange} />
          <Text className="text-xs text-ink-muted">{COPY.rangeDash}</Text>
          <CriteriaInput field="strikeMax" label={COPY.labelStrike} draft={draft} set={onChange} />
        </View>
      );
    case 'dte':
      return (
        <View className="h-8 flex-row items-center gap-xs">
          <RowLabel text={COPY.labelDte} dirty={dirty('dteBand')} />
          <CriteriaInput
            field="dteMin"
            label={COPY.labelDte}
            draft={draft}
            set={onChange}
            integer
          />
          <Text className="text-xs text-ink-muted">{COPY.rangeDash}</Text>
          <CriteriaInput
            field="dteMax"
            label={COPY.labelDte}
            draft={draft}
            set={onChange}
            integer
          />
        </View>
      );
    case 'premium':
      return (
        <View className="h-8 flex-row items-center gap-xs">
          <RowLabel text={COPY.labelPremium} dirty={dirty('premiumMin')} />
          <CriteriaInput
            field="premiumMin"
            label={COPY.labelPremium}
            draft={draft}
            set={onChange}
          />
          <PremiumTip open={tipOpen} onToggle={onToggleTip} />
        </View>
      );
    case 'liveness':
      // 🚨 中缝是「或」不是区间的 `–`：前者择一、后者取交。两支是**一个维度**（拆开会让同一条腿
      //    同时计进两行边际计数），故整行只有一个「已改」蓝点。
      return (
        <View className="h-8 flex-row items-center gap-xs">
          <RowLabel text={COPY.labelOi} dirty={dirty('livenessMin')} />
          <CriteriaInput field="oiMin" label={COPY.labelOi} draft={draft} set={onChange} integer />
          <Text className="text-xs text-ink-muted">{COPY.orWord}</Text>
          <Text className="text-xs text-ink-muted">{COPY.labelVol}</Text>
          <CriteriaInput
            field="volMin"
            label={COPY.labelVol}
            draft={draft}
            set={onChange}
            integer
          />
        </View>
      );
    case 'spread':
      return (
        <View className="h-8 flex-row items-center gap-xs">
          <RowLabel text={COPY.labelSpread} dirty={dirty('relativeSpreadMax')} />
          <CriteriaInput
            field="relativeSpreadMax"
            label={COPY.labelSpread}
            draft={draft}
            set={onChange}
          />
          {/* 无量纲比例 ⇒ 必须带 `%`：同一 sheet 里其余四项全是金额或张数。 */}
          <Text className="text-xs text-ink-muted">{COPY.percentSuffix}</Text>
        </View>
      );
  }
}

/** 行标签。改过的维度：标签转常规色 + 前置蓝点（双通道，别只靠颜色）。 */
function RowLabel({ text, dirty }: { text: string; dirty: boolean }) {
  return (
    <View className="w-20 flex-row items-center gap-1">
      {dirty ? <View className="h-1.5 w-1.5 rounded-full bg-brand-500" /> : null}
      <Text className={dirty ? 'text-xs text-ink' : 'text-xs text-ink-muted'}>{text}</Text>
    </View>
  );
}

/**
 * 数值框。空 = 不限（占位符），🚫 MUST NOT 预填 0 —— 「下限设为 0」与「不设下限」在契约里
 * 是两件事，而屏幕上它们看起来一模一样。
 * 📌 输入面就地清洗（只留数字与一个小数点）⇒ 非法值进不到提交映射那一层。
 */
function CriteriaInput({
  field,
  label,
  draft,
  set,
  integer = false,
}: {
  field: keyof CriteriaForm;
  label: string;
  draft: CriteriaForm;
  set: (field: keyof CriteriaForm, value: string) => void;
  integer?: boolean;
}) {
  return (
    <TextInput
      value={draft[field]}
      onChangeText={(text) => set(field, sanitizeNumeric(text, integer))}
      keyboardType={integer ? 'number-pad' : 'decimal-pad'}
      placeholder={COPY.unbounded}
      placeholderTextColor={colors.ink.subtle}
      accessibilityLabel={label}
      testID={`optionsdesk-detail-criteria-input-${field}`}
      className="h-7 min-w-14 rounded-md bg-surface-sunken px-sm text-center text-xs text-ink"
    />
  );
}

/** 只留数字与（非整数域的）一个小数点 —— 多余的点直接丢弃，不做「智能」纠错。O(n)。 */
function sanitizeNumeric(text: string, integer: boolean): string {
  const digitsOnly = text.replace(/[^0-9.]/g, '');
  if (integer) return digitsOnly.replace(/\./g, '');
  const [head, ...rest] = digitsOnly.split('.');
  return rest.length === 0 ? digitsOnly : `${head}.${rest.join('')}`;
}

/**
 * 权利金口径的 popup tip。**tap 开 / 再 tap 关**（移动端无 hover）。
 * 🚨 热区 44×44（图标视觉 13px）—— 别按图标尺寸做点击区。
 */
function PremiumTip({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <View className="justify-center">
      <Pressable
        onPress={onToggle}
        hitSlop={16}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={COPY.premiumTipLabel}
        testID="optionsdesk-detail-criteria-info"
        className="h-6 w-6 items-center justify-center"
      >
        {/* ⚠️ 图标（非文本内容）的对比度门槛是 3:1 —— `ink-subtle` 白底实测 2.85 不达标。 */}
        <Text className="text-[13px] text-ink-muted">{COPY.infoIcon}</Text>
      </Pressable>
      {open ? (
        <View
          className="absolute left-0 right-0 z-10 rounded-md border border-line bg-surface-alt px-sm py-xs"
          style={{ top: TIP_TOP, width: 260 }}
          testID="optionsdesk-detail-criteria-tip"
        >
          <Text className="text-[10px] text-ink">{COPY.premiumTip}</Text>
        </View>
      ) : null}
    </View>
  );
}
