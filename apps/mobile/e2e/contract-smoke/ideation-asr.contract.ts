/**
 * 035 ideation 语音输入 一次性识别 HTTP 契约冒烟（PR §V 第二层 / sdd.md [Contract-Smoke] 正交两层）。
 *
 * 用**生成的** @nvy/api-client 函数 `asrTranscribeControllerTranscribeAudio` 打**真 server**
 * （harness boot 的 testcontainers 后端，全 boot node dist/main.js），验 transcribe 端点的
 * **契约对齐 + 鉴权**（补 hermetic mock 与 server IT 都覆盖不到的缝：真 orval client ↔ 真路由 ↔
 * 真 DTO 序列化）：
 *   ① POST /api/v1/ideation/asr/transcribe（typed client，`{audioBase64, mimeType}`）→ 200 `{text}`；
 *      text = server `ASR_FAKE_SCRIPT` 确定性 transcript（ASR_PROVIDER=fake，不打真 DashScope）；
 *   ② 契约对齐：URL / method / 请求体序列化（audioBase64 + mimeType enum）/ 响应 `{text}` 形状；
 *   ③ 鉴权反枚举：无 Bearer → 401（authed 端点）。
 *
 * 端点进 OpenAPI（一次性 = 普通 REST，非 WS）→ orval **生成**了 `asrTranscribeControllerTranscribeAudio`
 * typed fn，故本 node 层直接调生成 fn（mobile 同款消费路径），经真 boot artifact + 真 JWT 验端到端。
 *
 * 音频不落库（FR-012）：transcribe 端点无状态、瞬态字节，不写任何表 → 本 spec 不验落库（与既有
 * ideation.contract 032 的落库验证正交）。transcript 经既有 turn 端点落库的文字路径由 032 兜底。
 *
 * 大模型/ASR 出口：harness 设 ASR_PROVIDER=fake → ideation.module `kind==='fake'` 工厂 bake
 * `ASR_FAKE_SCRIPT { text: '你想给行情页加收藏' }`，不打真 DashScope、不依赖外网、无需真
 * DASHSCOPE_API_KEY（fake 分支 asrConfig 不校验 key）。
 */
import assert from 'node:assert/strict';
import {
  AsrTranscribeRequestMimeType,
  asrTranscribeControllerTranscribeAudio,
} from '@nvy/api-client';

import type { RealBackendCtx } from '../_support/real-backend-harness';

export const name = 'ideation-asr (035)';

/** server ASR_FAKE_SCRIPT.text 镜像（ideation.module bake 的确定性 transcript，契约对齐验证锚）。 */
const FAKE_TRANSCRIPT = '你想给行情页加收藏';

/** 任意非空 base64（fake 不读音频内容，仅按 config 回放；真链此处是 DashScope 的 data-URL 载荷）。 */
const SAMPLE_AUDIO_BASE64 = Buffer.from('nvy-asr-contract-smoke-sample').toString('base64');

export async function run(ctx: RealBackendCtx): Promise<void> {
  const cfg = { baseURL: ctx.api, headers: { authorization: `Bearer ${ctx.accessToken}` } };

  // ── ① + ② 一次性识别：typed client POST → 200 {text} + 契约对齐 ───────────────────────
  const res = await asrTranscribeControllerTranscribeAudio(
    {
      audioBase64: SAMPLE_AUDIO_BASE64,
      mimeType: AsrTranscribeRequestMimeType['audio/aac'],
    },
    cfg,
  );
  assert.equal(res.status, 200, `transcribe expected 200, got ${res.status}`);
  assert.equal(
    typeof res.data.text,
    'string',
    'transcribe: 响应 {text} 为 string（非 null，避 nullable-@ApiProperty 坑）',
  );
  assert.equal(
    res.data.text,
    FAKE_TRANSCRIPT,
    'transcribe: text = ASR_FAKE_SCRIPT（server↔client 契约对齐 + 真 boot fake 回放）',
  );

  // ── ③ 鉴权反枚举：无 Bearer → 401 ──────────────────────────────────────────────────────
  await assert.rejects(
    () =>
      asrTranscribeControllerTranscribeAudio(
        {
          audioBase64: SAMPLE_AUDIO_BASE64,
          mimeType: AsrTranscribeRequestMimeType['audio/aac'],
        },
        { baseURL: ctx.api },
      ),
    (err: unknown) => {
      const e = err as { response?: { status?: number } };
      assert.equal(e.response?.status, 401, '未认证 transcribe → 401');
      return true;
    },
  );
}
