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
import { useState, type ReactNode } from 'react';
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
 * 每行画哪几个框 —— **键盘的初始落点**从它取（`firstFieldOf`）。
 * 📌 与 `leg-criteria.rules.ts` 里那份「维度 → 框」不是同一张表：那张按**维度**分组
 *    （活性一维两框、行权价两维两框），这张按**行**。
 * 📌 056 T005 起本表**不再是版面序** —— 屏上从上到下的顺序归 `SHEET_BLOCKS`（表达层独立
 *    常量，含合并行 `premiumSpread`）。两者恰好都以 `strike` 起手 ⇒ 初始落点仍是 `strikeMin`，
 *    但这是巧合而非约束：**改 `SHEET_BLOCKS` 的首块时要一并想清楚键盘该落在哪。**
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
  /**
   * 哪个 ⓘ 展开着。**MUST 是「哪一个」而不是单个 boolean**（056 T007 起同屏有两个 ⓘ）——
   * 共用一个 boolean 会让点权利金那个把行权价那个一起点亮，且屏上看着像「提示乱跳」。
   * 📌 同时只开一个是刻意的：两个浮层都 260px 宽、都绝对定位，同开会叠在一起。
   */
  const [openTip, setOpenTip] = useState<TipKey | null>(null);
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
          {SHEET_BLOCKS.map((blockKey) => (
            <CriteriaBlock
              key={blockKey}
              blockKey={blockKey}
              tab={tab}
              draft={draft}
              changed={changed}
              active={active}
              openTip={openTip}
              onToggleTip={(key) => setOpenTip((prev) => (prev === key ? null : key))}
              onSelect={setActive}
            />
          ))}

          {/* 🚨 键高固定（`h-16`）那条坑在 `~/ui/numeric-keypad.tsx` 文件头 —— 别在这里给它
              套一层无确定高度的 `flex-1` 容器。「搜」恒可点：条件一维没改也是合法提交。
              🚨 **「复位」并入右整列**（056 FR-020）—— 字段区那一行独占的复位已删。两键都随
              键盘常驻在屏内 ⇒ 🚫 MUST NOT 再在字段区复制任何一个（同屏两个同名按钮，FR-024）。
              📌 顺序（复位在上、搜在下，FR-021）与视觉双通道（搜 = brand 实心 flex-1 /
              复位 = 次级描边固定高，FR-022）都由键盘本体保证，本文件只递入参。 */}
          <NumericKeypad
            onKey={press}
            onConfirm={submit}
            confirmDisabled={false}
            confirmLabel={COPY.submit}
            confirmTestID="optionsdesk-detail-criteria-submit"
            secondaryLabel={COPY.reset}
            onSecondary={onReset}
            secondaryTestID="optionsdesk-detail-criteria-reset"
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
 * 抽屉的**版面序** —— 表达层独立常量。
 *
 * 🚨 **MUST NOT 用 `CRITERIA_ROWS` 的键序代劳**：那份序是**计数语义序**（`ROW_CRITERIA`
 *    「每行管哪几维」的键序），边际计数行的展示面跟着它走。为了排版面去动它，会静默改掉
 *    计数行的呈现顺序 —— 屏上不会红，只是数字换了位置。两者从此各自独立：本常量只管
 *    「屏上从上到下长什么样」。
 * 📌 `premiumSpread` 是把权利金与价差两维**并成一行等分两半**（`FR-011`）⇒ 块数从 5 降到 4，
 *    而**维度数一个没变**（`CRITERION_KEYS` 仍是六维）。
 */
const SHEET_BLOCKS = ['strike', 'dte', 'premiumSpread', 'liveness'] as const;
type SheetBlockKey = (typeof SHEET_BLOCKS)[number];

/** 同屏两个 ⓘ 各自的身份 —— 展开态记的是「哪一个」，不是一个共用的 boolean（`FR-016`）。 */
type TipKey = 'premium' | 'strike';

/**
 * 规则位槽宽 —— 预留到容得下未来的规则选择器（所需 124，`FR-031`）⇒ 将来升级**只换槽内内容**，
 * 块高与字段区版式不变。📌 用 `style` 而非 class 与本文件 `PremiumTip` 的既有写法一致。
 */
const RULE_SLOT_WIDTH = 130;

/**
 * 一个版面块。**一块 ≠ 一维**：行权价一块两个独立维度、期限与活跃度各一块一个维度（值是一对数）、
 * 权利金+价差一块两个维度。判据见 `leg-criteria.rules.ts` 文件头。
 *
 * 🚨 值区**一律齐右边界**（`FR-010` / `FR-013`）—— 靠框上的 `flex-1` 吃掉剩余宽度，而不是
 *    `min-w` 挤在左侧、右侧留一大片空白（那正是 owner 提的四条起因之一）。
 * 📌 这里的 `flex-1` 是**横向**的（父块 `h-8` 定高、框自带 `h-7`）—— 与 mobile-impl-playbook
 *    那条「无确定高度父容器内禁裸 `flex-1`」不冲突，那条说的是纵向塌缩。
 */
function CriteriaBlock({
  blockKey,
  tab,
  draft,
  changed,
  active,
  openTip,
  onToggleTip,
  onSelect,
}: {
  blockKey: SheetBlockKey;
  tab: LegPickerTab;
  draft: CriteriaForm;
  changed: readonly string[];
  active: keyof CriteriaForm;
  openTip: TipKey | null;
  onToggleTip: (key: TipKey) => void;
  onSelect: (field: keyof CriteriaForm) => void;
}) {
  const dirty = (...keys: readonly string[]) => keys.some((key) => changed.includes(key));
  const slot = { draft, active, onSelect };
  switch (blockKey) {
    case 'strike':
      return (
        <View
          testID="optionsdesk-detail-criteria-block-strike"
          className="h-8 flex-row items-center gap-xs"
        >
          {/* 🚨 ⓘ **只挂建仓**（`FR-016`）—— `K − bid < spot` 这道有效成本硬门槛无控件、不可调，
              **且不进边际计数**（`soleFailure === null` 那支明写「硬门槛不过 ⇒ 不进任何一维的
              计数」）⇒ 用户设了行权价却看到腿更少时，少掉的那部分可能是它切的，而屏上不解释。
              其余视角挂它是噪音。 */}
          <RowLabel
            text={COPY.labelStrike}
            dirty={dirty('strikeMin', 'strikeMax')}
            tip={
              tab === 'build' ? (
                <CriteriaTip
                  open={openTip === 'strike'}
                  onToggle={() => onToggleTip('strike')}
                  label={COPY.strikeTipLabel}
                  body={COPY.strikeTip}
                  testID="optionsdesk-detail-criteria-strike-info"
                  tipTestID="optionsdesk-detail-criteria-strike-tip"
                />
              ) : undefined
            }
          />
          <RangeValues min="strikeMin" max="strikeMax" label={COPY.labelStrike} {...slot} />
        </View>
      );
    case 'dte':
      return (
        <View
          testID="optionsdesk-detail-criteria-block-dte"
          className="h-8 flex-row items-center gap-xs"
        >
          <RowLabel text={COPY.labelDte} dirty={dirty('dteBand')} />
          <RangeValues min="dteMin" max="dteMax" label={COPY.labelDte} {...slot} />
        </View>
      );
    case 'premiumSpread':
      // ⚠️ **知情代价**（owner 已定）：本块右边界从一条变两条 —— 权利金齐中缝、价差齐外缘，
      //    全屏只有这一块带两条对齐线（`FR-011`）。换来的是行数 5→4 与两维各自的值区变宽。
      return (
        <View
          testID="optionsdesk-detail-criteria-block-premiumSpread"
          className="h-8 flex-row items-center gap-sm"
        >
          <View className="flex-1 flex-row items-center gap-xs">
            <RowLabel text={COPY.labelPremium} dirty={dirty('premiumMin')} />
            <CriteriaInput field="premiumMin" label={COPY.labelPremium} grow {...slot} />
            {/* 📌 权利金这个 ⓘ **留在值区**（`FR-016a` 管的是行权价那个）—— 它与右半边的
                `%` 单位对称：`FR-013` 本就把「单位跟在值区右端」算进值区，两半各带一个尾随
                元素，右缘反而是齐的。 */}
            <CriteriaTip
              open={openTip === 'premium'}
              onToggle={() => onToggleTip('premium')}
              label={COPY.premiumTipLabel}
              body={COPY.premiumTip}
              testID="optionsdesk-detail-criteria-info"
              tipTestID="optionsdesk-detail-criteria-tip"
            />
          </View>
          <View className="flex-1 flex-row items-center gap-xs">
            <RowLabel text={COPY.labelSpread} dirty={dirty('relativeSpreadMax')} />
            <CriteriaInput field="relativeSpreadMax" label={COPY.labelSpread} grow {...slot} />
            {/* 无量纲比例 ⇒ 必须带 `%`：同一 sheet 里其余四项全是金额或张数。单位跟在值区
                右端（`FR-013`）—— 知情代价是它离数字最远，取的是「右边界齐」那一头。 */}
            <Text className="text-xs text-ink-muted">{COPY.percentSuffix}</Text>
          </View>
        </View>
      );
    case 'liveness':
      // 🚨 「任一满足」MUST 由**带框分组块 + 分组标签**表达（`FR-030`），MUST NOT 退回夹在两框
      //    之间的「或」字 —— 主流期权筛选器一律把这两项做成独立 AND 项，用户带来的预期与本仓
      //    判据**相反**，而邻近性暗示不足以纠正它（GitLab DS / NN-g 共识）。
      // 🚨 整块仍是**一个维度**（`FR-033`）：只出一个「已改」蓝点、只出一份边际计数。分了组就
      //    把两框拆成两维的话，同一条腿会同时计进两行边际计数（`052` T010 有断言守）。
      return (
        <View
          testID="optionsdesk-detail-criteria-block-liveness"
          className="gap-xs rounded-md border border-line px-xs py-1.5"
        >
          <View className="flex-row items-center gap-xs">
            <GroupLabel text={COPY.livenessGroupLabel} dirty={dirty('livenessMin')} />
            {/* 🚫 只做一行**只读**说明：MUST NOT 实装可切换的 AND/OR，**禁用态的 segmented
                一并禁止** —— 禁用态说的是「暂时不能改」，而这里是「压根没有这个旋钮」，
                画一个点不动的选择器等于承诺一个不存在的能力（`FR-032`）。 */}
            <Text
              className="text-[10px] text-ink-muted"
              style={{ width: RULE_SLOT_WIDTH }}
              testID="optionsdesk-detail-criteria-liveness-rule"
            >
              {COPY.livenessRule}
            </Text>
          </View>
          <View className="h-7 flex-row items-center gap-xs">
            <Text className="w-10 text-xs text-ink-muted">{COPY.labelOi}</Text>
            <CriteriaInput field="oiMin" label={COPY.labelOi} grow {...slot} />
            <Text className="w-10 text-xs text-ink-muted">{COPY.labelVol}</Text>
            <CriteriaInput field="volMin" label={COPY.labelVol} grow {...slot} />
          </View>
        </View>
      );
  }
}

/**
 * 区间行的值区：`[框] – [框]`，两框等分并把值区撑到右边界。
 *
 * 🚫 MUST NOT 拆成显式的 `≥` / `≤`（`FR-035`）—— 拆开要多一份标签宽度，直接吃掉 `FR-010`
 *    争取来的值区宽度；且 `–`（区间取交）与活跃度块的分组语义已是两种可区分的表达。
 */
function RangeValues({
  min,
  max,
  label,
  draft,
  active,
  onSelect,
}: {
  min: keyof CriteriaForm;
  max: keyof CriteriaForm;
  label: string;
  draft: CriteriaForm;
  active: keyof CriteriaForm;
  onSelect: (field: keyof CriteriaForm) => void;
}) {
  return (
    <View className="flex-1 flex-row items-center gap-xs">
      <CriteriaInput
        field={min}
        label={label}
        draft={draft}
        active={active}
        onSelect={onSelect}
        grow
      />
      <Text className="text-xs text-ink-muted">{COPY.rangeDash}</Text>
      <CriteriaInput
        field={max}
        label={label}
        draft={draft}
        active={active}
        onSelect={onSelect}
        grow
      />
    </View>
  );
}

/** 分组块标签 —— 品牌浅底。改过的维度沿用与 `RowLabel` 同一套双通道语汇（转常规色 + 前置蓝点）。 */
function GroupLabel({ text, dirty }: { text: string; dirty: boolean }) {
  return (
    <View className="flex-row items-center gap-1 rounded bg-brand-soft px-xs py-0.5">
      {dirty ? (
        <View
          testID="optionsdesk-detail-criteria-dirty-dot"
          className="h-1.5 w-1.5 rounded-full bg-brand-500"
        />
      ) : null}
      <Text className={dirty ? 'text-[10px] text-ink' : 'text-[10px] text-ink-muted'}>{text}</Text>
    </View>
  );
}

/**
 * 行标签。改过的维度：标签转常规色 + 前置蓝点（双通道，别只靠颜色）。
 *
 * 🚨 `w-20` **定宽不变**（`flex: none`）—— `FR-010` 的「各行值区右缘对齐」是靠这条**结构保证**
 *    的，不是「量出来正好齐」：标签定宽 ⇒ 值区的起点与宽度一个像素都不被 `tip` 碰到。
 * 🚨 `tip` MUST 落在这里面（`FR-016a`，mockup 三候选同帧实测定案）—— 落值区右侧会让该行值区
 *    右缘短 32px（直接破 `FR-010`）；落值区内部虽保住右缘，但两个框各被挤掉 15px（125 → 110）。
 */
function RowLabel({ text, dirty, tip }: { text: string; dirty: boolean; tip?: ReactNode }) {
  return (
    <View
      className="w-20 flex-row items-center gap-1"
      testID="optionsdesk-detail-criteria-row-label"
    >
      {dirty ? (
        <View
          testID="optionsdesk-detail-criteria-dirty-dot"
          className="h-1.5 w-1.5 rounded-full bg-brand-500"
        />
      ) : null}
      <Text className={dirty ? 'text-xs text-ink' : 'text-xs text-ink-muted'}>{text}</Text>
      {tip}
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
 * 📌 选中态双通道：**下划线**转 `brand-500` **且**底色转 `brand-soft`（别只靠一种）。
 *
 * 🚨 形态是**下划线 + 值左对齐**，MUST NOT 退回圆角边框盒 + 居中文字（`FR-001`）——后者读成
 *    标签 / 胶囊，用户认不出这里可以改。左对齐同时给光标一个稳定的落点：值从左端长出去，
 *    光标始终跟在值尾，而居中排布会让光标随字数左右横跳。
 * 🚨 光标只是 2px 的 `View`，**MUST NOT 为了拿原生光标把值改回 `TextInput`**（`FR-002`）——
 *    `053` T015 正是为此改掉范式的（该机数字键盘占约 60% 屏高，弹起后抽屉被顶出屏外），
 *    而这条回退**在 web e2e 上永远不会红**（web 没有输入法）。守它的是「全屏无 textbox」那条断言。
 */
function CriteriaInput({
  field,
  label,
  draft,
  active,
  onSelect,
  grow = false,
}: {
  field: keyof CriteriaForm;
  label: string;
  draft: CriteriaForm;
  active: keyof CriteriaForm;
  onSelect: (field: keyof CriteriaForm) => void;
  /** 让框吃掉值区剩余宽度（`FR-010` 齐右边界）。省略 = 只占内容宽，保持既有行为。 */
  grow?: boolean;
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
      className={`h-7 min-w-14 flex-row items-center border-b-2 px-xs ${grow ? 'flex-1' : ''} ${
        on ? 'border-brand-500 bg-brand-soft' : 'border-line bg-surface-sunken'
      }`}
    >
      <Text
        className={`text-left font-mono text-xs ${value === '' ? 'text-ink-subtle' : 'text-ink'}`}
      >
        {value === '' ? COPY.unbounded : value}
      </Text>
      {/* 光标跟在值尾 —— 它是「键盘这一按会落到哪个框」的唯一视觉指认，故全屏恒只有一个。 */}
      {on ? (
        <View
          testID="optionsdesk-detail-criteria-caret"
          className="ml-0.5 h-3.5 w-0.5 bg-brand-500"
        />
      ) : null}
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
 * 口径 popup tip。**tap 开 / 再 tap 关**（移动端无 hover）。
 * 🚨 热区 44×44（图标视觉 13px）—— 别按图标尺寸做点击区。
 * 🚨 判据本身 MUST NOT 放进来，这里只放**口径说明** —— tooltip 易被忽略，把判据塞进去
 *    等于没写（NN/G）。056 T007 起两处复用同一形态，🚫 MUST NOT 新造第二种提示形态（`FR-016`）。
 */
function CriteriaTip({
  open,
  onToggle,
  label,
  body,
  testID,
  tipTestID,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
  body: string;
  testID: string;
  tipTestID: string;
}) {
  return (
    <View className="justify-center">
      <Pressable
        onPress={onToggle}
        hitSlop={16}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={label}
        testID={testID}
        className="h-6 w-6 items-center justify-center"
      >
        {/* ⚠️ 图标（非文本内容）的对比度门槛是 3:1 —— `ink-subtle` 白底实测 2.85 不达标。 */}
        <Text className="text-[13px] text-ink-muted">{COPY.infoIcon}</Text>
      </Pressable>
      {open ? (
        <View
          className="absolute left-0 right-0 z-10 rounded-md border border-line bg-surface-alt px-sm py-xs"
          style={{ top: TIP_TOP, width: 260 }}
          testID={tipTestID}
        >
          <Text className="text-[10px] text-ink">{body}</Text>
        </View>
      ) : null}
    </View>
  );
}
