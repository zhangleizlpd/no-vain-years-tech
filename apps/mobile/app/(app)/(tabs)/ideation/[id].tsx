// 032 T015/T016 — ideation 会话详情屏。两面切换（澄清对话 ⇄ brief 预览），由
// use-ideation-session 态机驱动。
//   - clarify 面（T015 ClarifyChatScreen）：多轮澄清流式 + chips + 自由文本 + 生成 brief。
//   - brief 面（T016 BriefPreviewScreen）：结构化分段 + 导出 markdown + 重新生成。
// 收敛闭环：clarify 点「生成 brief」→ generateBrief()；converged=true → 切 brief 面；
// converged=false → 用 missing 提示「继续追问缺失段」（留在 clarify 面）。
import { useCallback, useEffect, useRef, useState } from 'react';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  BriefPreviewScreen,
  ClarifyChatScreen,
  ideationMockupsRoute,
  useIdeationSession,
} from '~/ideation';

/** T1 段 key → 中文名（missing 提示用，穷举 5 段）。 */
const T1_MISSING_LABEL: Record<string, string> = {
  problem: '问题动机',
  user_stories: '用户故事',
  functional_requirements: '功能需求',
  success_criteria: '成功标准',
  non_goals: '非目标',
};

type Face = 'clarify' | 'brief';

export default function IdeationSessionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const sessionId = id ?? null;
  const router = useRouter();
  const {
    status,
    turns,
    error,
    session,
    send,
    stop,
    retry,
    generateBrief,
    isGeneratingBrief,
    repo,
    setRepo,
    retrieving,
  } = useIdeationSession(sessionId);

  const [face, setFace] = useState<Face>('clarify');
  const [missingHint, setMissingHint] = useState<string | null>(null);

  // 冷启 resume：已收敛 / 已交接会话（brief 在）首次落定 → 默认落 brief 面（一次性，不抢
  // 用户后续切回 clarify 继续追问的导航）。
  const autoFaced = useRef(false);
  useEffect(() => {
    if (autoFaced.current) return;
    if (session?.brief != null && (status === 'idle' || status === 'done')) {
      autoFaced.current = true;
      setFace('brief');
    }
  }, [session?.brief, status]);

  // 点「生成 brief」：converged → 切 brief 面；未收敛 → 列缺失段提示，留 clarify 面。
  const onGenerateBrief = useCallback(async () => {
    setMissingHint(null);
    const res = await generateBrief();
    if (res === null) return;
    if (res.converged) {
      setFace('brief');
      return;
    }
    const segs = res.missing.map((k) => T1_MISSING_LABEL[k] ?? k);
    setMissingHint(
      segs.length > 0
        ? `还差「${segs.join('、')}」没聊清楚，继续补充后再生成。`
        : '需求还差一些细节，继续补充后再生成。',
    );
  }, [generateBrief]);

  // 重新生成后：未收敛 → 回 clarify 面继续追问；收敛 → 留 brief 面（已 invalidate 刷新）。
  const onRegenerated = useCallback((converged: boolean) => {
    if (!converged) setFace('clarify');
  }, []);

  // 进设计稿区（037 T011 viewer）：同 tab 内 stack push，sessionId 走 query（导航单源在本父屏）。
  const onViewMockups = useCallback(() => {
    if (sessionId == null) return;
    router.push(ideationMockupsRoute({ sessionId }));
  }, [router, sessionId]);

  const showBrief = face === 'brief' && session?.brief != null;

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['bottom']}>
      {/* header 标题 = 灵感名称（session.title）；会话未落定前用中性占位，避免误导成「澄清」。 */}
      <Stack.Screen options={{ title: session?.title ?? '需求灵感' }} />
      {showBrief ? (
        <BriefPreviewScreen
          session={session}
          onRegenerated={onRegenerated}
          onViewMockups={onViewMockups}
        />
      ) : (
        <ClarifyChatScreen
          sessionId={sessionId}
          status={status}
          turns={turns}
          error={error}
          onSend={send}
          onStop={stop}
          onRetry={retry}
          onGenerateBrief={() => void onGenerateBrief()}
          isGeneratingBrief={isGeneratingBrief}
          missingHint={missingHint}
          selectedRepo={repo}
          onSelectRepo={setRepo}
          retrieving={retrieving}
        />
      )}
    </SafeAreaView>
  );
}
