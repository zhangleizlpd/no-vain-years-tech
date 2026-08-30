import { registerAs } from '@nestjs/config';
import { z } from 'zod';

/**
 * Optionsdesk 行军选档 config (069 T006, clarify Q3): φ 档界选择 + θ 模式开关。
 * server 配置项 only —— UI MUST NOT 暴露切换 (FR-011; 切换呈现归 P4)。
 *
 * 🚨 **两个 key 都是「缺失 → 默认, 非法 (含空串) → boot 抛」** (镜像 marketdata.config 那条
 * 教训): compose 未加载 env-file 时喂进来的是空串, `?? 'good'` 会把它静默吞掉 —— 拼错的
 * `godo` / `Theta` 同理。默认值 (good / phi) 的真相只在本 schema 一处。
 *
 * 📌 值域引用语义: `marchPhiTier` 对应 `leg-tier.rules.ts` `TIER_FLOORS_BY_BASIS.annualized`
 * 的三个有下界档 (`LegTierWithFloor`), `marchMode` 对应 `leg-march.rules.ts` `MARCH_MODES` ——
 * φ 数值本身不在 config 里 (FR-010 禁新造值, config 只选档界)。
 */
const OptionsdeskConfigSchema = z.object({
  marchPhiTier: z.enum(['good', 'acceptable', 'thin']).default('good'),
  marchMode: z.enum(['phi', 'theta']).default('phi'),
});

export type OptionsdeskConfig = z.infer<typeof OptionsdeskConfigSchema>;

export const optionsdeskConfig = registerAs(
  'optionsdesk',
  (): OptionsdeskConfig =>
    OptionsdeskConfigSchema.parse({
      marchPhiTier: process.env.OPTIONSDESK_MARCH_PHI_TIER,
      marchMode: process.env.OPTIONSDESK_MARCH_MODE,
    }),
);
