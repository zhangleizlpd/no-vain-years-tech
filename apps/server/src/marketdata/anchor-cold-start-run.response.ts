import { ApiProperty } from '@nestjs/swagger';
import { COLD_START_OUTCOMES } from './anchor-cold-start.rules.js';

export class AnchorColdStartRunResponse {
  @ApiProperty({ description: '锚 id (数字串)', example: '42' })
  anchorId!: string;

  @ApiProperty({ description: 'canonical `market:code`', example: 'us:CFG' })
  ticker!: string;

  @ApiProperty({
    description:
      '本次冷启动的结局。十档**两两互异, 禁折叠** —— 按结局分组的查询要能分出「本就不该做」' +
      '与「该做没做成」, 二者处置完全相反。',
    enum: COLD_START_OUTCOMES,
    example: 'backfilled',
  })
  outcome!: string;

  @ApiProperty({
    description: '结局的自由文本补充 (失败原因 / 跳过依据), 系统不解析',
    type: 'string',
    nullable: true,
    example: null,
  })
  reason!: string | null;

  @ApiProperty({
    description: '本次瞄准的交易日;早退分支 (市场未开通 / 日历缺行) 定位不到 ⇒ null',
    type: 'string',
    nullable: true,
    example: '2026-08-28',
  })
  targetSession!: string | null;

  @ApiProperty({ description: '最后一次运行时刻 (ISO-8601)', example: '2026-08-31T02:10:00.000Z' })
  lastRunAt!: string;

  @ApiProperty({
    description:
      '是否需要人工介入 (五档永久缺口)。期权 EOD **无跨日补救** ⇒ 这些是补不回来的窟窿。' +
      '判据单点在服务端 `anchor-cold-start.rules.ts`,**呈现层 MUST NOT 自己抄一份名单**。',
    example: false,
  })
  needsAttention!: boolean;
}

export class AnchorColdStartRunListResponse {
  @ApiProperty({
    description:
      '按 lastRunAt 升序。🚨 **查不到的 anchorId 不会出现在这里, 且这有语义**:「还没出行」= ' +
      '排队中或正在跑(十档结局全是终态)。呈现层据此算「N/M 已出结局」进度, MUST NOT 把缺席 ' +
      '当成失败, 也 MUST NOT 期待服务端补一个占位结局。',
    type: [AnchorColdStartRunResponse],
  })
  items!: AnchorColdStartRunResponse[];
}
