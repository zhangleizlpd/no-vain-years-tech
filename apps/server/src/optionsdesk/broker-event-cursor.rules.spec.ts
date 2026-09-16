import { describe, it, expect } from 'vitest';
import {
  decideCursor,
  type BrokerEventCursor,
  type BrokerEventCursorDecision,
} from './broker-event-cursor.rules';

/**
 * 084 T004 事件游标判定单测 (Small: 纯函数, 零外部依赖, 与源码 colocate)。
 *
 * 形态照 golden sample `radar-cursor.spec.ts`。夹具全为合成值: `epoch` 是假的十六进制串、
 * 序号是小整数 —— 本文件不含任何真实账户 / 成交 / 订单数据 (testing.md §7)。
 *
 * 🚨 **两种断档必须分别喂** (plan「本片额外的反例臂」): 只测「序号跳号」的话,「代次变化时
 * 沿用旧序号」的漏判不会红; 只测「代次变化」的话, 跳号的漏判不会红。再加 ① 这条
 * 「常规重启但未绕回 ⇒ 不判断档」的反例臂, 否则「每拍都判断档」的实现也能通过前两条。
 *
 * 定向变异 (out-of-test sabotage, testing.md §7.1; 2026-09-16 实跑, 还原后 `cmp` 与备份逐字节相同):
 *   a. 代次变化时沿用旧 `lastSeq` —— 重建支的 `empty ? EMPTY_EPOCH_SEQ` 改成
 *      `empty ? (local?.lastSeq ?? EMPTY_EPOCH_SEQ)` → 1 failed | 9 passed —— 只有 ④ 红
 *   b. 只判 `dropped` 不判跳号 —— 跳号那一支 `first.seq > local.lastSeq + 1` 改成恒假的
 *      `first.seq < 0` → 1 failed | 9 passed —— 只有 ② 红
 *   ⚠️ b 改成「整支删掉」会让 `first` 变成未引用而撞 TS6133, 测试**根本不会跑** —— 那种红不是
 *   证据 (local-verification.md §3「变异红的不是断言」)。故变异点挑在编译得过的比较符上。
 *   复跑: pnpm nx test server src/optionsdesk/broker-event-cursor.rules.spec.ts --skip-nx-cache
 */

/** 两个合成代次串, 只要不相等即可 —— 真值是 shim 进程启动时 mint 的 uuid hex。 */
const EPOCH_A = 'aaaa0000epoch';
const EPOCH_B = 'bbbb1111epoch';

const LOCAL: BrokerEventCursor = { epoch: EPOCH_A, lastSeq: 10 };

/** 最小事件行: 本判定只看 `seq`, 其余列原样透传 (消费方才解读 `event_type`)。 */
interface PushEvent {
  seq: number;
  event_type: 'order';
}

function rows(...seqs: number[]): PushEvent[] {
  return seqs.map((seq) => ({ seq, event_type: 'order' }));
}

/** shim 语义: 有行 ⇒ `next_seq` = 末行 `seq`; 无行 ⇒ 原样回传入参 `after_seq`。 */
function response(
  epoch: string,
  seqs: number[],
  { dropped = false, afterSeq = LOCAL.lastSeq }: { dropped?: boolean; afterSeq?: number } = {},
) {
  const batch = rows(...seqs);
  return { epoch, rows: batch, nextSeq: batch.at(-1)?.seq ?? afterSeq, dropped };
}

describe('decideCursor — 断档与代次判定 (084 FR-003 / FR-009; plan D4)', () => {
  it('① 序号连续 ⇒ 不判断档, 游标推进到末行 (branch 22: 常规重启但缓冲未绕回的正常路径)', () => {
    const decision = decideCursor({ local: LOCAL, response: response(EPOCH_A, [11, 12, 13]) });
    expect(decision.gapDetected).toBe(false);
    expect(decision.accepted.map((r) => r.seq)).toEqual([11, 12, 13]);
    expect(decision.nextCursor).toEqual({ epoch: EPOCH_A, lastSeq: 13 });
  });

  it('② 首行序号跳号 ⇒ 判断档 (branch 5) —— 行仍照常消费, 补偿是另一条腿', () => {
    const decision = decideCursor({ local: LOCAL, response: response(EPOCH_A, [12, 13]) });
    expect(decision.gapDetected).toBe(true);
    expect(decision.accepted.map((r) => r.seq)).toEqual([12, 13]);
    expect(decision.nextCursor).toEqual({ epoch: EPOCH_A, lastSeq: 13 });
  });

  it('③ `dropped` 为真 ⇒ 判断档, 即使本批序号自身连续 (branch 23: 缓冲绕回)', () => {
    const decision = decideCursor({
      local: LOCAL,
      response: response(EPOCH_A, [11, 12], { dropped: true }),
    });
    expect(decision.gapDetected).toBe(true);
    expect(decision.nextCursor).toEqual({ epoch: EPOCH_A, lastSeq: 12 });
  });

  it('④ 代次变化 ⇒ 判断档, 游标从新代次重建, `lastSeq` 🚫 沿用旧值 (branch 6)', () => {
    const withRows = decideCursor({ local: LOCAL, response: response(EPOCH_B, [1, 2]) });
    expect(withRows.gapDetected).toBe(true);
    expect(withRows.nextCursor).toEqual({ epoch: EPOCH_B, lastSeq: 2 });

    // 🚨 这一臂是要害: 新代次下缓冲还空着, shim 的 `next_seq` 原样回传的是**旧代次**的序号。
    // 沿用它 ⇒ 下一拍以 after_seq=10 去问新进程, 新代次的前 10 条事件被永久跳过且不报错。
    const empty = decideCursor({ local: LOCAL, response: response(EPOCH_B, []) });
    expect(empty.gapDetected).toBe(true);
    expect(empty.nextCursor).toEqual({ epoch: EPOCH_B, lastSeq: 0 });
    expect(empty.nextCursor.lastSeq).not.toBe(LOCAL.lastSeq);
  });

  it('⑤ 首次消费 (`local = null`) ⇒ 接受全部, 不判断档', () => {
    const decision = decideCursor({ local: null, response: response(EPOCH_A, [7, 8, 9]) });
    expect(decision.gapDetected).toBe(false);
    expect(decision.accepted.map((r) => r.seq)).toEqual([7, 8, 9]);
    expect(decision.nextCursor).toEqual({ epoch: EPOCH_A, lastSeq: 9 });
  });

  it('⑤b 首次消费且缓冲为空 ⇒ 不判断档, 游标钉在新代次的起点', () => {
    const decision = decideCursor({
      local: null,
      response: response(EPOCH_A, [], { afterSeq: 0 }),
    });
    expect(decision.gapDetected).toBe(false);
    expect(decision.accepted).toEqual([]);
    expect(decision.nextCursor).toEqual({ epoch: EPOCH_A, lastSeq: 0 });
  });

  it('⑥ 空批 (通道静默) ⇒ 游标逐字段不变, 不判断档 (branch 9 的判定半)', () => {
    const decision = decideCursor({ local: LOCAL, response: response(EPOCH_A, []) });
    expect(decision.gapDetected).toBe(false);
    expect(decision.accepted).toEqual([]);
    expect(decision.nextCursor).toEqual(LOCAL);
  });

  it('⑥b 空批 + `dropped` ⇒ 仍判断档 (停机过久后重连, 首拍可能什么都没拉到)', () => {
    const decision = decideCursor({
      local: LOCAL,
      response: response(EPOCH_A, [], { dropped: true }),
    });
    expect(decision.gapDetected).toBe(true);
    expect(decision.nextCursor).toEqual(LOCAL);
  });

  it('连续拉多拍 ⇒ 游标逐拍推进且一条不漏 (末行 seq 即下一拍的 after_seq)', () => {
    let cursor: BrokerEventCursor | null = null;
    const seen: number[] = [];
    for (const batch of [[1, 2], [3], [4, 5, 6]]) {
      // 显式标注切断 TS7022: 循环里 `cursor` 的收窄类型来自 `decision`, 而 `decision` 又要靠
      // `cursor` 推断 —— 自我指涉。
      const decision: BrokerEventCursorDecision<PushEvent> = decideCursor({
        local: cursor,
        response: response(EPOCH_A, batch),
      });
      expect(decision.gapDetected).toBe(false);
      seen.push(...decision.accepted.map((r) => r.seq));
      cursor = decision.nextCursor;
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6]);
    expect(cursor).toEqual({ epoch: EPOCH_A, lastSeq: 6 });
  });

  it('accepted 原样透传整行 (判定不裁字段, 消费方才解读 `event_type`)', () => {
    const decision = decideCursor({ local: LOCAL, response: response(EPOCH_A, [11]) });
    expect(decision.accepted[0]).toEqual({ seq: 11, event_type: 'order' });
  });
});
