import { ApiProperty } from '@nestjs/swagger';
import type { AlertTrigger } from '../generated/prisma/client';

/**
 * 021 消息中心读侧投影 (EP6-EP8)。消息渲染全走 AlertTrigger 快照字段
 * (不 join 活 Alert — 删除后消息完整可读, plan §快照自洽)；正文文案
 * 「股价跌到13.00元（今日最低12.80元）」由 mobile 按 {type,threshold,actual}
 * 渲染, 不进契约。数值跨边界 string (015 体例); nullable string 显式
 * `type:'string'` (防 orval object-map)。
 */
export class MessageConditionItem {
  @ApiProperty({ description: '条件类型', example: 'PRICE_FALL_TO' })
  type!: string;

  @ApiProperty({
    description: '条件参数快照 (023; 无参/旧消息省略)',
    required: false,
    example: 20,
  })
  param?: number;

  @ApiProperty({
    description: '阈值快照 (Decimal string; 无阈值类型 null)',
    type: 'string',
    nullable: true,
    example: '13.0000',
  })
  threshold!: string | null;

  @ApiProperty({ description: '触发日实际值快照 (Decimal string)', example: '12.8000' })
  actual!: string;

  @ApiProperty({
    description: '估值快照日 YYYY-MM-DD (023; 仅估值条件携带, FR-S01)',
    required: false,
    example: '2026-06-04',
  })
  dataDate?: string;

  @ApiProperty({
    description: '求值口径快照 (024 FR-007; intraday=盘中价, 旧消息缺字段 → mobile 按 eod 兜底)',
    required: false,
    enum: ['intraday', 'eod'],
    example: 'intraday',
  })
  priceContext?: 'intraday' | 'eod';
}

export class MessageItem {
  @ApiProperty({ description: '消息 id (= trigger id, 数字串)', example: '301' })
  id!: string;

  @ApiProperty({ description: '市场', example: 'cn' })
  market!: string;

  @ApiProperty({ description: '标的代码', example: '603305' })
  code!: string;

  @ApiProperty({ description: '股票名 (触发时快照)', example: '旭升集团' })
  instrumentName!: string;

  @ApiProperty({ description: '触发交易日 YYYY-MM-DD', example: '2026-06-05' })
  tradeDate!: string;

  @ApiProperty({ description: '命中条件快照 (全条件 AND 命中)', type: [MessageConditionItem] })
  conditions!: MessageConditionItem[];

  @ApiProperty({
    description: '预警备注快照',
    nullable: true,
    type: 'string',
    example: '低吸观察',
  })
  note!: string | null;

  @ApiProperty({ description: '触发时间 ISO-8601', example: '2026-06-05T15:05:00.000Z' })
  triggeredAt!: string;

  @ApiProperty({ description: '是否未读 (triggeredAt > 账号已读水位线, 服务端计算)' })
  unread!: boolean;
}

/** EP6 `GET /alert/messages` 响应 (triggeredAt 倒序 + keyset 分页)。 */
export class MessageListResponse {
  @ApiProperty({ description: '消息列表 (triggeredAt 倒序)', type: [MessageItem] })
  messages!: MessageItem[];

  @ApiProperty({
    description: '下页游标 (= 本页末条消息 id); null = 无更多',
    nullable: true,
    type: 'string',
    example: '301',
  })
  nextCursor!: string | null;
}

/** EP7 未读计数 / EP8 置已读 (恒 unread:0) 共用响应。 */
export class UnreadCountResponse {
  @ApiProperty({ description: '未读消息数', example: 3 })
  unread!: number;
}

/** Json 快照元素容错取串 (引擎写 string; 历史/手插 number 兼容)。 */
function snapshotValue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return '';
}

/**
 * conditionsSnapshot Json → 投影 (非数组/缺键容错, 不抛 — 消息流不因脏行中断)。
 * 023 (plan D7): param/dataDate 仅快照携带时透传 (旧消息缺键 → 省略, mobile 兜底渲染);
 * threshold 缺失/null → null (无阈值类型)。024 (plan D7): priceContext 盘中触发携带
 * 'intraday'，旧 EOD 消息缺键 → 省略 (mobile 按 eod 兜底)。
 */
export function parseConditionsSnapshot(json: unknown): MessageConditionItem[] {
  if (!Array.isArray(json)) return [];
  return json.map((entry) => {
    const o = (entry ?? {}) as Record<string, unknown>;
    return {
      type: snapshotValue(o['type']),
      ...(typeof o['param'] === 'number' && o['param'] !== 0 ? { param: o['param'] } : {}),
      threshold: o['threshold'] == null ? null : snapshotValue(o['threshold']),
      actual: snapshotValue(o['actual']),
      ...(typeof o['dataDate'] === 'string' ? { dataDate: o['dataDate'] } : {}),
      ...(o['priceContext'] === 'intraday' || o['priceContext'] === 'eod'
        ? { priceContext: o['priceContext'] }
        : {}),
    };
  });
}

/** 贫血 trigger row → 消息投影 (unread 由 caller 持水位线计算)。 */
export function toMessageItem(row: AlertTrigger, lastReadAt: Date | null): MessageItem {
  return {
    id: row.id.toString(),
    market: row.market,
    code: row.code,
    instrumentName: row.instrumentName,
    tradeDate: row.tradeDate.toISOString().slice(0, 10),
    conditions: parseConditionsSnapshot(row.conditionsSnapshot),
    note: row.noteSnapshot,
    triggeredAt: row.triggeredAt.toISOString(),
    unread: lastReadAt === null || row.triggeredAt.getTime() > lastReadAt.getTime(),
  };
}
