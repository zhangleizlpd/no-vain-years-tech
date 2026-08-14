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
// 🚨 **值是只读显示 + 自绘键盘，MUST NOT 改回 `TextInput`**（053 T015，spec `FR-045` 的
//    2026-08-14 裁定）—— T013 真机验收读出的两条 FAIL 同源于「系统键盘 + 输入框」：
//    ① 输入法弹起后**整个抽屉被顶出屏外**（该机数字键盘占约 60% 屏高，连正在编辑的框都看不见）
//    ② 六个条件值在真机上**读不出数**（`TextInput` 上的 className 颜色未如期生效，值淡于标签）。
//    值改成只读 `Text` + 自绘键盘后 ① **结构性消失**（系统键盘根本不弹，无「顶不顶得起」可言）、
//    ② 一并解掉（普通 `Text` 走 token 颜色）。范式与键盘本体同 `alert/value-input-sheet.tsx`
//    （键盘已上提 `~/ui`）。🚫 仓内另两条 keyboard-controller 路线只解 ①、不解 ②，已否。
//
// 渲染 / 交互 / a11y 走 T013 Playwright e2e（本仓测试分层：vitest=logic / Playwright=UI）。
import { useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';

import { BACKSPACE, NumericKeypad, SafeAreaView } from '~/ui';
import {
  changedCriteria,
  criteriaFormOf,
  CRITERIA_ROWS,
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

/**
 * 每行画哪几个框，**按渲染序**（`CriteriaRow` 的 switch 逐行同序）—— 键盘的初始落点从它取。
 * 📌 与 `leg-criteria.rules.ts` 里那份「维度 → 框」不是同一张表：那张按**维度**分组
 *    （活性一维两框、行权价两维两框），这张是**版面顺序**，只服务于「先落在哪个框上」。
 */
const ROW_FIELDS: Readonly<Record<CriteriaRowKey, readonly (keyof CriteriaForm)[]>> = {
  strike: ['strikeMin', 'strikeMax'],
  dte: ['dteMin', 'dteMax'],
  premium: ['premiumMin'],
  liveness: ['oiMin', 'volMin'],
  spread: ['relativeSpreadMax'],
};

/**
 * 哪些框是整数域（天数 / 张数）。**穷举 `Record`** ⇒ 表单加一个框而这里漏标即编译红。
 * 📌 整数域上小数点键是**空按** —— `sanitizeNumeric` 直接把点丢掉，与原先 `number-pad`
 *    键盘上根本没有小数点等价（🚫 MUST NOT 改成「点了就补 .0」之类的智能纠错）。
 */
const INTEGER_FIELD: Readonly<Record<keyof CriteriaForm, boolean>> = {
  strikeMin: false,
  strikeMax: false,
  dteMin: true,
  dteMax: true,
  premiumMin: false,
  oiMin: true,
  volMin: true,
  relativeSpreadMax: false,
};

/**
 * 键盘的初始落点 = 第一行的第一个框（行集恒非空；兜底取权利金 —— 它在三视角都在）。
 * 📌 056 行集统一的**行为副作用**：建仓此前第一行是 `期限天` ⇒ 落 `dteMin`，现在第一行是
 *    `行权价` ⇒ 落 `strikeMin`。这是行集统一的直接推论，不是 bug。
 */
function firstFieldOf(rows: readonly CriteriaRowKey[]): keyof CriteriaForm {
  const row = rows[0];
  return (row === undefined ? undefined : ROW_FIELDS[row][0]) ?? 'premiumMin';
}

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
  /** 键盘编辑的是**哪一个框** —— 键盘常驻，故没有「谁都没选中」这一态（起手落在第一个框）。 */
  const [active, setActive] = useState<keyof CriteriaForm>(() => firstFieldOf(CRITERIA_ROWS));

  const changed = changedCriteria(draft, defaults);
  const pending = !sameCriteriaForm(draft, submitted ?? base);
  const press = (key: string) =>
    setDraft((prev) => ({
      ...prev,
      [active]: applyCriteriaKey(prev[active], key, INTEGER_FIELD[active]),
    }));

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
        {/* `max-h-[92%]`：sheet 限高（M3/HIG 都对 modal sheet 留顶部间隙）；底部 safe-area 由
            `SafeAreaView edges=bottom` 原生量取 —— Android 15 edge-to-edge 下让键盘末行
            `0/./⌫` 避开手势条（同 `alert/value-input-sheet.tsx`）。 */}
        <SafeAreaView
          edges={['bottom']}
          className="max-h-[92%] gap-xs rounded-t-lg bg-surface px-md pb-md pt-sm shadow-sheet"
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

          {/* 🚨 **三视角同一份行集**（056 FR-012）—— 不再按 tab 裁行：某一维默认值为空 ⇒ 该行
              照常出现并呈「不限」，那是一个**用户可用的旋钮**，不是「没有这个旋钮」。
              📌 行为惰性：被藏的两行默认值本来就都是 `null`（判据不生效）⇒ 默认候选集零变化。 */}
          {CRITERIA_ROWS.map((row) => (
            <CriteriaRow
              key={row}
              row={row}
              draft={draft}
              changed={changed}
              active={active}
              tipOpen={tipOpen}
              onToggleTip={() => setTipOpen((prev) => !prev)}
              onSelect={setActive}
            />
          ))}

          {/* 「搜」与「复位」**并存** —— 不是 049 那种互斥槽位（FR-012 + FR-013 是两件事）。
              「搜」= 键盘右整列（自绘键盘的确定位，同 `alert/value-input-sheet.tsx`）⇒ 它随键盘
              常驻在屏内，🚫 MUST NOT 再在这一行复制一个「搜」（同屏两个同名按钮）。 */}
          <View className="flex-row justify-end pt-sm">
            <Pressable
              onPress={onReset}
              accessibilityRole="button"
              accessibilityLabel={COPY.reset}
              testID="optionsdesk-detail-criteria-reset"
              className="rounded-full border border-line px-lg py-1.5"
            >
              <Text className="text-xs text-ink">{COPY.reset}</Text>
            </Pressable>
          </View>

          {/* 🚨 键高固定（`h-16`）那条坑在 `~/ui/numeric-keypad.tsx` 文件头 —— 别在这里给它
              套一层无确定高度的 `flex-1` 容器。「搜」恒可点：条件一维没改也是合法提交。 */}
          <NumericKeypad
            onKey={press}
            onConfirm={submit}
            confirmDisabled={false}
            confirmLabel={COPY.submit}
            confirmTestID="optionsdesk-detail-criteria-submit"
          />
        </SafeAreaView>
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
  active,
  tipOpen,
  onToggleTip,
  onSelect,
}: {
  row: CriteriaRowKey;
  draft: CriteriaForm;
  changed: readonly string[];
  active: keyof CriteriaForm;
  tipOpen: boolean;
  onToggleTip: () => void;
  onSelect: (field: keyof CriteriaForm) => void;
}) {
  const dirty = (...keys: readonly string[]) => keys.some((key) => changed.includes(key));
  switch (row) {
    case 'strike':
      return (
        <View className="h-8 flex-row items-center gap-xs">
          <RowLabel text={COPY.labelStrike} dirty={dirty('strikeMin', 'strikeMax')} />
          <CriteriaInput
            field="strikeMin"
            label={COPY.labelStrike}
            draft={draft}
            active={active}
            onSelect={onSelect}
          />
          <Text className="text-xs text-ink-muted">{COPY.rangeDash}</Text>
          <CriteriaInput
            field="strikeMax"
            label={COPY.labelStrike}
            draft={draft}
            active={active}
            onSelect={onSelect}
          />
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
            active={active}
            onSelect={onSelect}
          />
          <Text className="text-xs text-ink-muted">{COPY.rangeDash}</Text>
          <CriteriaInput
            field="dteMax"
            label={COPY.labelDte}
            draft={draft}
            active={active}
            onSelect={onSelect}
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
            active={active}
            onSelect={onSelect}
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
          <CriteriaInput
            field="oiMin"
            label={COPY.labelOi}
            draft={draft}
            active={active}
            onSelect={onSelect}
          />
          <Text className="text-xs text-ink-muted">{COPY.orWord}</Text>
          <Text className="text-xs text-ink-muted">{COPY.labelVol}</Text>
          <CriteriaInput
            field="volMin"
            label={COPY.labelVol}
            draft={draft}
            active={active}
            onSelect={onSelect}
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
            active={active}
            onSelect={onSelect}
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
 * 数值框 —— **只读显示**，点它 = 把键盘的落点挪过来（053 T015，文件头第四条）。
 *
 * 空 = 不限（占位符），🚫 MUST NOT 预填 0 —— 「下限设为 0」与「不设下限」在契约里是两件事，
 * 而屏幕上它们看起来一模一样。
 * 🚨 值走**普通 `Text` 的 token 颜色**（`text-ink`，与行标签同深）——「值比标签淡到读不出」
 *    正是真机 FAIL ②；占位符才用 `ink-subtle`（它说的是「这里没有值」，不是一个值）。
 * 📌 选中态双通道：边框转 `brand-500` **且**底色转 `brand-soft`（别只靠一种）。
 */
function CriteriaInput({
  field,
  label,
  draft,
  active,
  onSelect,
}: {
  field: keyof CriteriaForm;
  label: string;
  draft: CriteriaForm;
  active: keyof CriteriaForm;
  onSelect: (field: keyof CriteriaForm) => void;
}) {
  const value = draft[field];
  const on = active === field;
  return (
    <Pressable
      onPress={() => onSelect(field)}
      accessibilityRole="button"
      accessibilityLabel={`${label} ${value === '' ? COPY.unbounded : value}`}
      accessibilityState={{ selected: on }}
      testID={`optionsdesk-detail-criteria-input-${field}`}
      className={`h-7 min-w-14 justify-center rounded-md border px-sm ${
        on ? 'border-brand-500 bg-brand-soft' : 'border-line bg-surface-sunken'
      }`}
    >
      <Text
        className={`text-center font-mono text-xs ${value === '' ? 'text-ink-subtle' : 'text-ink'}`}
      >
        {value === '' ? COPY.unbounded : value}
      </Text>
    </Pressable>
  );
}

/**
 * 一次按键落到当前选中的框（O(n)，n = 显示串长度）。
 *
 * 🚨 **判据仍是本屏的 `sanitizeNumeric`，MUST NOT 改用 `~/ui` 的 `applyKey`**（053 T015 裁定）
 *    —— 那份是 026 alert 阈值屏的规范化：整数位 ≤7 / **小数位 ≤2** + 前导零改写。而本屏的
 *    权利金默认值是服务端下发的四位小数（`0.2384`），套上去就**打不回来**。两者冲突处以
 *    `sanitizeNumeric` 为准（它「只留数字与非整数域的一个小数点，多余的点直接丢弃，不做智能
 *    纠错」的语义在本次改造中一字未动）。
 * 📌 退格是纯截尾（空串幂等）—— 它不是「值」的规范化，故不过 `sanitizeNumeric`。
 */
function applyCriteriaKey(raw: string, key: string, integer: boolean): string {
  if (key === BACKSPACE) return raw.slice(0, -1);
  return sanitizeNumeric(raw + key, integer);
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
