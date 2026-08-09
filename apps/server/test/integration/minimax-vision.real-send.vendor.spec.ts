import { describe, it, expect } from 'vitest';
import { MinimaxProvider } from '../../src/integrations/llm/minimax.provider.js';
import type {
  Msg,
  LlmStreamEvent,
  LlmStreamOptions,
} from '../../src/integrations/llm/llm-provider.port.js';

/**
 * 036 T001 [Spike] — MiniMax M3 视觉多模态 round-trip PoC（env-gated，默认 skip）。
 *
 * facts #1/#3 已核 M3 国内站原生支持 OpenAI 兼容 `image_url` content parts,但
 * M3 `thinking:adaptive`（思考内联进 content）+ 视觉的**实测延迟 / 稳定性**未验。
 * 本 IT 喂一张小图（`data:` base64 或 public URL）+ 文字到现有 `minimax.provider.ts`
 * （`model:'MiniMax-M3'`,content parts `[{type:'text'},{type:'image_url'}]`）→ 验真返回
 * 对焦文本、记录端到端延迟。复用现有 provider 的 content-parts 透传路径,**不改 provider 实现**。
 *
 * **默认 skip**（env-gated,per memory env_gated_perf_it_pattern）:
 *   需真 MINIMAX_API_KEY + 真网络打 MiniMax（产生 token 费用 + 不确定延迟）,CI / 常规
 *   `nx affected` 不跑。`describe.skipIf(!RUN_M3_VISION_IT)` 未设 env 时整块跳过
 *   （与 aliyun-sms.real-send.vendor / timing-defense.p95.it 同范式）。
 *
 * **本地 / 部署期启用**（key 放 gitignored env / shell,禁入仓）:
 *   RUN_M3_VISION_IT=true MINIMAX_API_KEY=<真 key> \
 *   [MINIMAX_BASE_URL=<覆盖,默认国内站>] \
 *   [M3_VISION_IT_IMAGE_URL=<public 图 URL,缺省用内置 1x1 data: PNG>] \
 *   pnpm nx test server -- minimax-vision.real-send.vendor
 *
 * **结论留 PR**: 真 M3 验证延迟 / 稳定性观测 deferred 到部署期（需 RUN_M3_VISION_IT + 真 key）;
 *   本仓环境无真 key → 本 IT 骨架默认 skip,不入 CI,不阻塞下方 fake-provider 路径。
 */
const RUN_M3_VISION_IT = process.env.RUN_M3_VISION_IT === 'true';

// 内置最小占位图（1x1 透明 PNG，base64 data: URL）。缺省 fixture，让无 public 图也能跑链路。
const DEFAULT_DATA_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe.skipIf(!RUN_M3_VISION_IT)(
  'MinimaxProvider 视觉 round-trip 真发 IT (env-gated, 默认 skip)',
  () => {
    const apiKey = process.env.MINIMAX_API_KEY ?? '';
    const baseUrl = process.env.MINIMAX_BASE_URL ?? 'https://api.minimaxi.com/v1';
    const imageUrl = process.env.M3_VISION_IT_IMAGE_URL ?? DEFAULT_DATA_IMAGE;

    it('真 key → 喂「图 + 文字」content parts,M3 返回对焦文本(无 throw),记录延迟', async () => {
      // 缺 key → 明确报错(而非静默用空串打到 MiniMax 拿无意义鉴权错误)。
      if (!apiKey) {
        throw new Error('视觉 round-trip IT 缺 env: MINIMAX_API_KEY（启用时必设）');
      }

      const provider = new MinimaxProvider({ apiKey, baseUrl });

      // OpenAI 兼容 vision content parts：文字 + 图片 URL（data: 或 public）。
      // content 为数组形态 → 经 toApiMessages 原样透传（T004 多模态扩展后的目标形状）。
      const messages: Msg[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: '请用一句话描述这张图片，并指出最显著的视觉元素。' },
            { type: 'image_url', image_url: { url: imageUrl } },
          ],
        },
      ];
      const opts: LlmStreamOptions = {
        signal: new AbortController().signal,
        model: 'minimax',
      };

      const startedAt = Date.now();
      const tokens: string[] = [];
      for await (const event of provider.stream(messages, opts) as AsyncIterable<LlmStreamEvent>) {
        if (event.kind === 'token') tokens.push(event.text);
      }
      const elapsedMs = Date.now() - startedAt;
      const focusText = tokens.join('');

      // eslint-disable-next-line no-console
      console.log(
        `[minimax-vision.real-send.vendor] elapsedMs=${elapsedMs} chars=${focusText.length} text=${focusText.slice(0, 200)}`,
      );

      // 真返回对焦文本（非空可见正文）= 视觉链路通；延迟仅观测记录，不做硬阈断言。
      expect(focusText.trim().length).toBeGreaterThan(0);
    }, 120_000);
  },
);
