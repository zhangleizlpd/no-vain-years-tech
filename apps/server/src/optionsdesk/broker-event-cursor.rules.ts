/**
 * 084 券商推送事件的**游标与断档判定**纯函数 (plan D4; FR-003 / FR-009)。无 I/O、无 DI
 * (ADR-0043 §4)。
 *
 * 事件源 (`services/futu-shim/src/futu_shim/trade_events.py`) 给每条事件盖一个进程内单调
 * `seq`, 并给整个缓冲盖一个进程启动时 mint 的 `epoch`。**两个标识各管一件事**:
 *
 * | 标识    | 回答的问题                         |
 * | ------- | ---------------------------------- |
 * | `seq`   | 「没有新事件」还是「我漏了几条」   |
 * | `epoch` | 「序号从头开始了」还是「序号断了」 |
 *
 * 没有 `epoch` 这两件事不可区分: 事件源重启后 `seq` 合法地回到 1, 与「缓冲绕回把我的游标甩在
 * 后面」在数值上长得一模一样。
 *
 * 🚨 **游标只存进程内存, MUST NOT 建表持久化** (plan D4): 消费方进程重启后 `local` 为 `null`,
 * 首拍按「首次消费」接受; 事件源重启则由 `epoch` 比对自然判出 —— 两种重启都已覆盖, 持久化只是
 * 多一张表和一处一致性要维护。
 *
 * 🚨 **断档不丢行**: 判出断档时本批仍照常 `accepted` 返回。断档的后果是**额外**发起一次当日
 * 缺口补偿 (FR-009), 不是丢弃这批已经拿到的事件。
 */

/** 消费方记住的位置:「我读到了哪个代次的第几号」。 */
export interface BrokerEventCursor {
  epoch: string;
  /** 已消费的最大序号; 该代次尚未消费任何事件 ⇒ {@link EMPTY_EPOCH_SEQ}。 */
  lastSeq: number;
}

/** 事件行在本文件的最小形状 —— 判定只看序号, 其余列 (`event_type` / 券商列) 原样透传。 */
export interface SequencedBrokerEvent {
  seq: number;
}

/** 事件源一次读取的响应 (`GET /trade/events` 信封里 `as_of` / `count` 之外的四个字段)。 */
export interface BrokerEventResponse<TRow extends SequencedBrokerEvent = SequencedBrokerEvent> {
  epoch: string;
  rows: readonly TRow[];
  /**
   * 下次该回传的 `after_seq`: 本批末行的 `seq`; **无行时事件源原样回传入参**
   * (`trade_events.py` `TradeEventBuffer.read`)。后半句正是 {@link decideCursor} 不能无条件
   * 采信它的原因 —— 见函数内注释。
   */
  nextSeq: number;
  /** 请求的游标已早于缓冲最旧一条 ⇒ 两者之间的事件已被覆盖。 */
  dropped: boolean;
}

export interface BrokerEventCursorDecision<
  TRow extends SequencedBrokerEvent = SequencedBrokerEvent,
> {
  /** 本批可消费的行 (原样透传, 不裁字段、不拷贝)。 */
  accepted: readonly TRow[];
  /** 需要对该市场当日发起一次缺口补偿 (FR-009)。 */
  gapDetected: boolean;
  nextCursor: BrokerEventCursor;
}

/** 新代次尚未消费任何事件时的游标位置。事件源的 `seq` 自 1 起, 故 0 表示「什么都还没读」。 */
export const EMPTY_EPOCH_SEQ = 0;

/**
 * 本拍的消费决定。断档判据三条, 任一成立即触发补偿:
 *
 * 1. **代次变化** ⇒ 事件源重启 ⇒ 断档, 且游标**从新代次的起点重建** (branch 6)。
 * 2. **`dropped`** ⇒ 缓冲绕回, 游标与缓冲最旧一条之间的事件已被覆盖 (branch 23)。
 * 3. **首行 `seq` > `lastSeq + 1`** ⇒ 中间缺号 (branch 5)。
 *
 * 序号连续且未绕回 ⇒ 正常消费、不触发补偿 (branch 22) —— 这是「服务端常规重启但缓冲还兜得住」
 * 的正常路径, 必须与断档区分开, 否则每次例行部署都留一条补偿痕迹, 把 FR-014 赖以判断通道
 * 健康的信号淹掉。
 *
 * 首次消费 (`local === null`) 接受本批并从中建游标, **不判断档**: 此前没有任何位置可言, 判成
 * 断档会让每次服务端启动都多发一次补偿。
 *
 * 复杂度 O(rows) (上界; 判定本身只读首行与 `nextSeq` = O(1), `accepted` 原样透传不拷贝)。
 */
export function decideCursor<TRow extends SequencedBrokerEvent>({
  local,
  response,
}: {
  local: BrokerEventCursor | null;
  response: BrokerEventResponse<TRow>;
}): BrokerEventCursorDecision<TRow> {
  const empty = response.rows.length === 0;

  // 首次消费与代次变化都从新代次重建游标, 区别只在要不要补偿。
  if (local === null || response.epoch !== local.epoch) {
    return {
      accepted: response.rows,
      // 代次变化恒判断档 (事件源重启期间的事件不会重来); 首次消费不判。
      gapDetected: local !== null || response.dropped,
      // 🚨 无行时 `nextSeq` 是入参 `after_seq` 的原样回传, 属**旧**代次 —— 采信它就是 D4 明令
      // 禁止的「按旧序号续拉」: 下一拍拿旧序号去问新进程, 新代次头几条事件被永久跳过且不报错。
      nextCursor: { epoch: response.epoch, lastSeq: empty ? EMPTY_EPOCH_SEQ : response.nextSeq },
    };
  }

  const first = response.rows[0];
  return {
    accepted: response.rows,
    gapDetected: response.dropped || (first !== undefined && first.seq > local.lastSeq + 1),
    // 同代次无行 ⇒ 游标原地不动 (此时 `nextSeq` 恰是原样回传, 效果相同; 取本地值则不依赖那个约定)。
    nextCursor: { epoch: response.epoch, lastSeq: empty ? local.lastSeq : response.nextSeq },
  };
}
