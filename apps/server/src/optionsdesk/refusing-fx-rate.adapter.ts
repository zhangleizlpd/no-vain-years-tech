import { FX_RATE_PORT, type FxRate, type FxRatePort } from './fx-rate.port';

/**
 * FX 取数被拒的专属错误 —— **可识别**是它的全部意义 (立意照
 * `marketdata/refusing-collection.adapter.ts` 的 `MockCollectionRefusedError`)。
 *
 * 文案写给**本地 dev 的读者**, 不是写给写这行的人: 撞上它的人多半正在纳闷「为什么这屏没有
 * 汇率」, 所以要当场说清「这是配置使然, 不是故障」以及怎么才能打真 vendor。
 */
export class FxRateRefusedError extends Error {
  constructor(readonly port: string) {
    super(
      `[optionsdesk] FX 取数口 ${port}.fetchRates() 在 MARKETDATA_PROVIDER=mock 下拒绝提供数据 —— ` +
        '这是配置使然, 不是故障。本地 dev 与 IT 一律跑 mock 档, 而汇率的真源是腾讯 / 新浪的' +
        '公开 vendor 端点 —— 每开一次那一屏就替它们计一次数。要打真 vendor 请设 ' +
        'MARKETDATA_PROVIDER=live。',
    );
    this.name = 'FxRateRefusedError';
  }
}

/**
 * 085 T004 `FX_RATE_PORT` 在 `MARKETDATA_PROVIDER=mock` 下的绑定物 —— **一调即抛**, 绝不返回
 * 伪造汇率 (FR-002; 立意照 marketdata 054 的采集口拒绝壳)。
 *
 * 🚨 **不返伪造汇率而是抛**: 汇率是**乘在每一行金额上**的数 —— 一个假汇率不会让任何东西报错,
 * 只会让整屏数字静静地错, 与 054「伪造行情与真行情同形、事后无从分辨」是同一病根。抛才有信号。
 *
 * 🚫 **不照抄那份的泛型 Proxy**: 那边是 27 个采集口 / 34 个方法, 一个 Proxy 顶掉全部才划算,
 * 代价是维护 `INFRA_PROBE_KEYS` 那张「漏一个不是红, 是崩或挂」的清单 (Nest 生命周期探测 +
 * `then` thenable 陷阱)。本 port 只有 `fetchRates` 一个方法 ⇒ 一个普通类就够; 把那份复杂度
 * 搬过来才是照抄形状。
 *
 * 🚨 **跨 ctx 不可 import** (Guardrail 9 / ADR-0053): 不 import `marketdata/` 那份, 照写法
 * 另落一份 —— 与 T001 的 `decodeGbk` 同样的并存处理, 是已批准状态。
 *
 * **走 Promise 拒绝而非同步 throw**: 与真 adapter 的失败形态一致 (传输错 / 解析契约破都是
 * rejected promise) ⇒ 上游 (T006) 的 catch 分支不必为 mock 档多写一条。
 */
export class RefusingFxRateAdapter implements FxRatePort {
  fetchRates(): Promise<readonly FxRate[]> {
    return Promise.reject(new FxRateRefusedError(FX_RATE_PORT.description ?? 'FX_RATE_PORT'));
  }
}
