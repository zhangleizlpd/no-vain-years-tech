import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useWechatBindingControllerBindWechatForMe } from '@nvy/api-client';
import { useAuthStore } from '~/auth';
import { meQueryKey } from '~/core/api/me-query-key';
import { wechatBindErrorToast } from './wechat-errors';

// Phase 1 stub: 真实 native 微信授权 (Phase 2, T030) 的占位。返回确定性假 authCode
// —— web e2e 全链可测; server stub adapter 由 authCode 派生确定性 openid。Phase 2
// 用真实 `sendAuthRequest` 拿授权 code 替换本函数 (bind 端点契约不变)。
export function authorizeWechatStub(): string {
  return 'wx-stub-authcode';
}

export type WechatBindState = 'idle' | 'submitting' | 'success' | 'error';

// 微信绑定状态机 (镜像 useGenderEdit: 单 action → invalidate /me → success/error latch)。
// **不脏写** (FR-C06): 仅服务端确认 + /me refetch 后行才翻「解绑」—— 本 hook 不乐观
// 改本地态; wechatBound 真值随 useMe 刷新。submitting 由 mutation.isPending 单源。
export function useWechatBind() {
  const bind = useWechatBindingControllerBindWechatForMe();
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<'idle' | 'success' | 'error'>('idle');
  const [errorToast, setErrorToast] = useState<string | null>(null);

  const start = useCallback(async () => {
    if (bind.isPending) return;
    setErrorToast(null);
    try {
      const authCode = authorizeWechatStub();
      await bind.mutateAsync({ data: { authCode } });
      // 仅服务端确认后翻行: invalidate /me → wechatBound 刷新 → 行翻「解绑」。
      await queryClient.invalidateQueries({
        queryKey: meQueryKey(useAuthStore.getState().accountId),
      });
      setPhase('success');
    } catch (e) {
      // 409/网络等失败 → toast, 行保持「绑定」(不脏写)。
      setErrorToast(wechatBindErrorToast(e));
      setPhase('error');
    }
  }, [bind, queryClient]);

  const state: WechatBindState = bind.isPending ? 'submitting' : phase;
  return { start, state, errorToast };
}
