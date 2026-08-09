// 032 T016 — brief 预览 / 导出屏（翻面 C，brief-preview.dc.html 3 态 baseline）。
//
// 结构化分段渲染（契约 §2，**非 markdown 源码**）：
//   - T1 五段：实卡全渲（GWT 验收 + FR 编号在内容字符串里，渲染零拆解）。
//   - T2 接地段：本期 stub 留空 → 灰虚线**非阻塞占位**（非报错，FR-011 / SC-007）；有内容正常渲。
//   - T3 可选段：空则整段跳（小颗粒自适应），有内容淡化渲。
//   - 状态徽标：open / converged / handed-off 穷举 Record（STATUS_BADGE_META）。
// 段视图数据准备 = brief-view.rules.ts 纯逻辑（vitest 覆盖）；本屏只渲。
//
// 动作（mockup action bar）：
//   - 「复制 md」：briefControllerExport（GET）→ markdown → expo-clipboard
//     setStringAsync + 成功 toast；导出后 server 落 handed-off → invalidate 让徽标回流。
//   - 「重新生成」= **reopen + generate 两步**（T009 决策：已 converged / handed-off 会话重生
//     必先 reopen 回 open 再 generate 覆盖单份）→ invalidate session query 刷新 brief。
//   - 「设计稿」：onViewMockups 回调 → 父屏 push 设计稿区（037 T011 viewer 入口；无 mockup 落空态）。
// 导航 / 屏切换单源在父屏（[id].tsx）；本屏只回调 onRegenerated / onViewMockups（父刷新态/切面 / 导航）。
//
// 视觉 0 新 token：复用 ~/theme（brand/ink/line/surface/ok/warn）+ ~/ui（Spinner）。
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import {
  briefControllerExport,
  briefControllerGenerate,
  getSessionControllerGetQueryKey,
  sessionControllerReopen,
  type SessionDetailResponse,
} from '@nvy/api-client';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

import { colors } from '~/theme';
import { Spinner } from '~/ui';
import { IDEATION_COPY } from './ideation-copy';
import {
  buildBriefSegments,
  normalizeStatus,
  STATUS_BADGE_META,
  type BriefSegmentView,
} from './brief-view.rules';

export interface BriefPreviewScreenProps {
  /** 会话详情（含 brief；本屏只在 brief != null 时由父挂载）。 */
  session: SessionDetailResponse;
  /** 重新生成后回调（父刷新态：未收敛则回 clarify 面继续追问）。 */
  onRegenerated?: (converged: boolean) => void;
  /** 进设计稿区回调（父屏 push 设计稿区；导航单源在父屏 [id].tsx，缺则不渲入口）。 */
  onViewMockups?: () => void;
}

export function BriefPreviewScreen({
  session,
  onRegenerated,
  onViewMockups,
}: BriefPreviewScreenProps) {
  const queryClient = useQueryClient();
  const sessionId = session.id;

  const [exporting, setExporting] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const briefJson = (session.brief?.briefJson ?? {}) as Record<string, unknown>;
  const segments = buildBriefSegments(briefJson);
  const status = normalizeStatus(session.status);
  const badge = STATUS_BADGE_META[status];

  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: getSessionControllerGetQueryKey(sessionId) }),
    [queryClient, sessionId],
  );

  const flashToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2400);
  }, []);

  // 「复制 md」：export（GET，server 落 handed-off）→ Clipboard + toast。
  const onExport = useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const res = await briefControllerExport(sessionId);
      await Clipboard.setStringAsync(res.data.markdown);
      flashToast(IDEATION_COPY.briefCopiedToast);
      void invalidate(); // 徽标回流 handed-off。
    } catch {
      flashToast(IDEATION_COPY.briefExportFailed);
    } finally {
      setExporting(false);
    }
  }, [exporting, sessionId, flashToast, invalidate]);

  // 「重新生成」= reopen（回 open）+ generate（覆盖单份），per T009。
  const onRegenerate = useCallback(async () => {
    if (regenerating) return;
    setRegenerating(true);
    try {
      await sessionControllerReopen(sessionId);
      const res = await briefControllerGenerate(sessionId);
      void invalidate();
      onRegenerated?.(res.data.converged);
      if (!res.data.converged) {
        flashToast(IDEATION_COPY.briefRegenerateFailed);
      }
    } catch {
      flashToast(IDEATION_COPY.briefRegenerateFailed);
    } finally {
      setRegenerating(false);
    }
  }, [regenerating, sessionId, invalidate, onRegenerated, flashToast]);

  const t1Count = segments.filter((s) => s.tier === 't1').length;
  const t2PendingCount = segments.filter((s) => s.tier === 't2' && s.isPlaceholder).length;

  return (
    <View className="flex-1 bg-surface-sunken" testID="ideation-brief-screen">
      {/* handed-off 回流提示条（mockup ③）。 */}
      {status === 'handed-off' ? (
        <View
          className="flex-row items-center gap-2 bg-surface-alt px-md py-2.5"
          testID="ideation-brief-handed-note"
        >
          <InfoIcon />
          <Text className="text-xs text-ink-muted">{IDEATION_COPY.briefHandedOffNote}</Text>
        </View>
      ) : null}

      {/* brief 正文：分段卡片。 */}
      <View className="flex-1">
        <ScrollView
          className="flex-1"
          contentContainerClassName="px-md pt-md pb-lg gap-md"
          testID="ideation-brief-body"
        >
          {/* 标题块 + 状态徽标 + 段数概览。 */}
          <View className="gap-1.5">
            <View className="flex-row items-center gap-2">
              <Text className="text-2xl font-bold text-ink flex-1" testID="ideation-brief-title">
                {session.title}
              </Text>
              <StatusBadge label={badge.label} tone={badge.tone} />
            </View>
            <Text className="text-xs text-ink-muted">
              {t1Count} 个核心段{t2PendingCount > 0 ? ` · ${t2PendingCount} 个待填` : ''}
            </Text>
          </View>

          {segments.map((seg, i) => (
            <SegmentCard key={seg.key} segment={seg} index={i} />
          ))}
        </ScrollView>
      </View>

      <ActionBar
        exporting={exporting}
        regenerating={regenerating}
        onExport={() => void onExport()}
        onRegenerate={() => void onRegenerate()}
        onViewMockups={onViewMockups}
      />

      {/* 成功 / 失败 toast（绝对定位，自动消失）。 */}
      {toast !== null ? <BriefToast message={toast} /> : null}
    </View>
  );
}

// ──────────────────────────── 动作条 + toast ────────────────────────────

function ActionBar({
  exporting,
  regenerating,
  onExport,
  onRegenerate,
  onViewMockups,
}: {
  exporting: boolean;
  regenerating: boolean;
  onExport: () => void;
  onRegenerate: () => void;
  onViewMockups?: () => void;
}) {
  const busy = exporting || regenerating;
  // 动作顺序（用户流程从左到右）：① 复制 md → ② 设计稿（生成 mockup）→ ③ 重新生成。
  // 三按钮 flex-1 等宽对齐（复制 md 为主按钮，brand 高亮）。
  return (
    <View className="flex-row gap-2.5 px-md pt-2.5 pb-5 bg-surface border-t border-line">
      <Pressable
        onPress={onExport}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={IDEATION_COPY.briefExport}
        accessibilityState={{ disabled: busy, busy: exporting }}
        className="flex-1 h-12 rounded-md bg-brand-500 items-center justify-center flex-row gap-1.5 shadow-cta active:bg-brand-600"
        style={{ opacity: busy ? 0.6 : 1 }}
        testID="ideation-brief-export-button"
      >
        {exporting ? <Spinner size={16} tone="white" /> : <CopyIcon />}
        <Text className="text-sm font-semibold text-white">{IDEATION_COPY.briefExport}</Text>
      </Pressable>
      {onViewMockups ? (
        <Pressable
          onPress={onViewMockups}
          accessibilityRole="button"
          accessibilityLabel={IDEATION_COPY.mockupViewEntry}
          className="flex-1 h-12 rounded-md border border-line bg-surface items-center justify-center flex-row gap-1.5"
          testID="ideation-brief-view-mockups-button"
        >
          <MockupIcon />
          <Text className="text-sm font-medium text-ink-muted">
            {IDEATION_COPY.mockupViewEntry}
          </Text>
        </Pressable>
      ) : null}
      <Pressable
        onPress={onRegenerate}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={IDEATION_COPY.briefRegenerate}
        accessibilityState={{ disabled: busy, busy: regenerating }}
        className="flex-1 h-12 rounded-md border border-line bg-surface items-center justify-center flex-row gap-1.5"
        style={{ opacity: busy ? 0.6 : 1 }}
        testID="ideation-brief-regenerate-button"
      >
        {regenerating ? <Spinner size={15} tone="muted" /> : <RetryIcon />}
        <Text className="text-sm font-medium text-ink-muted">{IDEATION_COPY.briefRegenerate}</Text>
      </Pressable>
    </View>
  );
}

function BriefToast({ message }: { message: string }) {
  return (
    <View
      className="absolute self-center flex-row items-center gap-2 bg-ink rounded-md px-md py-2.5 shadow-modal"
      style={{ bottom: 96, left: '50%', transform: [{ translateX: -150 }], width: 300 }}
      testID="ideation-brief-toast"
    >
      <View className="w-5 h-5 rounded-full bg-ok items-center justify-center">
        <CheckIcon />
      </View>
      <Text className="text-sm text-white flex-1">{message}</Text>
    </View>
  );
}

// ──────────────────────────── 分段卡片（T1 实 / T2 占位 / T3 淡化） ────────────────────────────

function SegmentCard({ segment, index }: { segment: BriefSegmentView; index: number }) {
  const num = String(index + 1).padStart(2, '0');

  // T2 空段 → 灰虚线非阻塞占位（非报错样式）。
  if (segment.tier === 't2' && segment.isPlaceholder) {
    return (
      <View
        className="border border-dashed border-line rounded-lg bg-surface-sunken px-md py-3.5 gap-1.5"
        testID="ideation-brief-grounding-placeholder"
      >
        <View className="flex-row items-center gap-2">
          <PlaceholderIcon />
          <Text className="text-sm font-semibold text-ink-subtle">{segment.title}</Text>
        </View>
        <Text className="text-xs text-ink-subtle leading-relaxed">
          {IDEATION_COPY.briefGroundingPlaceholder}
        </Text>
      </View>
    );
  }

  const dimmed = segment.tier === 't3';
  return (
    <View
      className="bg-surface border border-line rounded-lg px-md py-3.5 gap-2"
      style={{ opacity: dimmed ? 0.85 : 1 }}
      testID="ideation-brief-segment"
    >
      <View className="flex-row items-center gap-2">
        <View className="rounded-sm bg-brand-soft px-1.5 py-0.5">
          <Text className="text-xs font-bold text-brand-600">{num}</Text>
        </View>
        <Text className="text-base font-semibold text-ink">{segment.title}</Text>
      </View>
      {/* 内容 = 自由文本 string（GWT / FR 编号自带在内容里），按段渲，非 markdown 源码解析。 */}
      <Text className="text-sm text-ink-muted leading-relaxed">{segment.content}</Text>
    </View>
  );
}

function StatusBadge({ label, tone }: { label: string; tone: 'brand' | 'muted' }) {
  const cls = tone === 'brand' ? 'bg-brand-soft' : 'bg-surface-alt';
  const dotCls = tone === 'brand' ? 'bg-brand-500' : 'bg-ink-subtle';
  const textCls = tone === 'brand' ? 'text-brand-600' : 'text-ink-muted';
  return (
    <View
      className={`flex-row items-center gap-1.5 rounded-full px-2 py-1 ${cls}`}
      testID="ideation-brief-status-badge"
    >
      <View className={`w-1.5 h-1.5 rounded-full ${dotCls}`} />
      <Text className={`text-xs font-semibold ${textCls}`}>{label}</Text>
    </View>
  );
}

// ─────────────────────────────── icons（屏内一次性，承 027 范式） ───────────────────────────────

function CopyIcon() {
  return (
    <Svg
      width={17}
      height={17}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#fff"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Rect x={9} y={9} width={11} height={11} rx={2.5} />
      <Path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </Svg>
  );
}

function RetryIcon() {
  return (
    <Svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={colors.ink.muted}
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Path d="M3 12a9 9 0 1 0 2.6-6.4L3 8" />
      <Path d="M3 3v5h5" />
    </Svg>
  );
}

function MockupIcon() {
  return (
    <Svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={colors.ink.muted}
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Rect x={5} y={3} width={14} height={18} rx={2.5} />
      <Path d="M5 8h14" />
      <Path d="M9 13h6" />
      <Path d="M9 17h3" />
    </Svg>
  );
}

function PlaceholderIcon() {
  return (
    <Svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={colors.ink.subtle}
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Rect x={3} y={3} width={18} height={18} rx={4} />
      <Path d="M12 8v8" />
      <Path d="M8 12h8" />
    </Svg>
  );
}

function InfoIcon() {
  return (
    <Svg
      width={15}
      height={15}
      viewBox="0 0 24 24"
      fill="none"
      stroke={colors.ink.muted}
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Circle cx={12} cy={12} r={9} />
      <Path d="M12 11v5" />
      <Circle cx={12} cy={8} r={0.6} fill={colors.ink.muted} />
    </Svg>
  );
}

function CheckIcon() {
  return (
    <Svg
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#fff"
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Path d="M5 12.5l4.5 4.5L19 7" />
    </Svg>
  );
}
