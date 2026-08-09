// 037 T011 [US1] — 设计稿（mockup）渲染屏（从 session 进入「设计稿」区）。
//
// 渲染态（useSessionMockups 数据驱动，fetch-on-open 无实时刷新 FR-011）：
//   ① loading  首屏拉取        居中 Spinner
//   ② error    读列表 GET 失败  提示 + 重试（FR-009，不渲空假态、不阻断 session）
//   ③ empty    该 session 无 mockup（空态非错误，US1 AC3）  「暂无设计稿」引导
//   ④ render   有 mockup       MockupRenderer 渲染**最新版**（versionRank 1）
//   ⑤ degrade  产物不可达/加载失败  一次性降级横幅 + 重试（US1 AC4 / FR-009，不崩、不阻断）
//
// 多版切换条 = T014：MockupVersionStrip（append-only 倒序 chips，latest 默认选中）+ 屏标签行
// （选中版 screens[]）。点历史 chip → 换 selectedId → 切 MockupRenderer uri + 标签行重渲该版
// （FR-006 + Clarification Q1/Q2，fetch-on-open 不重拉）。隔离渲染由 MockupRenderer 平台拆分担保
// （native WebView JS-off + origin 锁 / web iframe sandbox）。渲染降级 = 「记录存在 ≠ 渲染成功」解耦：
// 即便读列表成功，MockupRenderer.onError（产物不可达）也仅本屏一次性提示，不影响 session 其余功能。
//
// 路由屏 = app/ 树下只放路由屏；数据 hook / 渲染组件 / 纯逻辑在 src/ideation/（Expo Router app/
// 扫描铁律）。presentational/编排 —— 无 vitest（hook 派生 / 视图态走 use-session-mockups.spec；
// 切换 / 倒序 / 默认 latest 纯逻辑走 mockup-version.rules.spec；render / 状态屏浏览 / 切版 / 降级走
// T013+T015 Playwright Web e2e）。
import { useCallback, useEffect, useState } from 'react';
import { Stack, useLocalSearchParams } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import {
  IDEATION_COPY,
  isRenderableMockupUrl,
  MockupRenderer,
  MockupVersionStrip,
  selectDefaultVersionId,
  selectMockupById,
  useSessionMockups,
  type MockupScreenParams,
} from '~/ideation';
import { Button, Spinner } from '~/ui';

export default function SessionMockupScreen() {
  const { sessionId } = useLocalSearchParams<MockupScreenParams>();
  const { items, isPending, isError, isEmpty, refetch } = useSessionMockups(sessionId ?? null);

  // 选中版态（默认 latest = versionRank 1；切版只换 uri + 标签行，fetch-on-open 不重拉，FR-006）。
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // items 落定（首拉 / 多版交付）时锚定默认 latest；用户已选则不覆盖（仅 null 时初始化）。
  useEffect(() => {
    setSelectedId((cur) => (cur === null ? selectDefaultVersionId(items) : cur));
  }, [items]);
  const selected = selectMockupById(items, selectedId);

  // 渲染降级态（MockupRenderer.onError 触发；与读列表 isError 正交——记录存在 ≠ 渲染成功）。
  const [renderFailed, setRenderFailed] = useState(false);
  const onRenderError = useCallback(() => setRenderFailed(true), []);
  const retryRender = useCallback(() => setRenderFailed(false), []);
  // 切版 → 收起上一版的渲染降级横幅（新版可能可达）。
  const onSelectVersion = useCallback((id: string) => {
    setSelectedId(id);
    setRenderFailed(false);
  }, []);

  return (
    <View className="flex-1 bg-bg" testID="ideation-mockup-screen">
      <Stack.Screen options={{ title: IDEATION_COPY.mockupHeading }} />

      {/* ① loading */}
      {isPending ? (
        <View
          className="flex-1 items-center justify-center bg-surface"
          testID="ideation-mockup-loading"
        >
          <Spinner />
        </View>
      ) : isError ? (
        // ② error（读列表 GET 失败，可重试，不阻断 session）
        <View
          className="flex-1 items-center justify-center gap-md bg-surface px-xl"
          testID="ideation-mockup-list-error"
        >
          <Text className="text-base text-ink-muted">{IDEATION_COPY.mockupListError}</Text>
          <Button label={IDEATION_COPY.mockupRetry} onPress={refetch} />
        </View>
      ) : isEmpty || !isRenderableMockupUrl(selected?.mockupUrl) ? (
        // ③ empty（无 mockup 非错误，US1 AC3）。选中版不可渲染（OSS 未配 mockupUrl=null / 脏域）
        // 亦折叠到空态——无可内联渲染的产物。
        <EmptyState />
      ) : (
        // ④ 多版切换条 + 屏标签行（选中版）+ render 选中版 + ⑤ 渲染降级横幅（onError → 一次性提示 + 重试）
        <View className="flex-1">
          <MockupVersionStrip
            items={items}
            selectedId={selected.id}
            onSelect={onSelectVersion}
            screens={selected.screens}
          />
          {renderFailed ? (
            <DegradeBanner onRetry={retryRender} />
          ) : (
            <MockupRenderer
              key={selected.id}
              uri={selected.mockupUrl}
              onError={onRenderError}
              testID="ideation-mockup-renderer"
            />
          )}
        </View>
      )}
    </View>
  );
}

// ─────────────────────────── 空态（该 session 无 mockup，US1 AC3） ───────────────────────────

function EmptyState() {
  return (
    <View
      className="flex-1 items-center justify-center bg-surface px-xl gap-sm"
      testID="ideation-mockup-empty"
    >
      <Text className="text-base text-ink text-center">{IDEATION_COPY.mockupEmpty}</Text>
      <Text className="text-sm text-ink-muted text-center leading-relaxed">
        {IDEATION_COPY.mockupEmptyHint}
      </Text>
    </View>
  );
}

// ─────────────────── 渲染降级横幅（产物不可达，US1 AC4 / FR-009，一次性 + 重试） ───────────────────

function DegradeBanner({ onRetry }: { onRetry: () => void }) {
  return (
    <View
      className="flex-1 items-center justify-center gap-md bg-surface px-xl"
      testID="ideation-mockup-render-error"
    >
      <Text className="text-base text-ink-muted text-center">
        {IDEATION_COPY.mockupRenderError}
      </Text>
      <Pressable
        onPress={onRetry}
        accessibilityRole="button"
        accessibilityLabel={IDEATION_COPY.mockupRetry}
        testID="ideation-mockup-render-retry"
        className="h-12 px-xl rounded-full bg-brand-500 items-center justify-center active:bg-brand-600"
      >
        <Text className="text-base font-semibold text-white">{IDEATION_COPY.mockupRetry}</Text>
      </Pressable>
    </View>
  );
}
