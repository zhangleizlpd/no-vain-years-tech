/**
 * 采集口在 `MARKETDATA_PROVIDER=mock` 下的绑定物 —— 一调即抛, 绝不返回伪造数据 (054 FR-004)。
 *
 * 054 之前 mock 下**全部**端口都绑 `MockMarketDataAdapter`, 含 27 个采集口 + 1 个采集源。
 * 这些口的产出**必然被持久化** ⇒ 伪造行情与真行情同形落进真表, 事后无从分辨 (2026-08-12
 * 实撞: 行数对得上、日志全绿, 灌进来的却是假行情)。自本文件起, mock 下只有**读取口**继续
 * 绑 `MockMarketDataAdapter` (dev 只读能力零回归, FR-009), 采集口一律绑这里的拒绝壳。
 *
 * **不手写 27 个采集口接口的对等实现** (plan D-2): `MockMarketDataAdapter` 有 931 行 / 34 个
 * 方法, 照它对等手写一个拒绝类是 senior engineer 会当场判过度的形态 —— 一个泛型 Proxy 工厂
 * 顶掉全部。
 */

/**
 * 采集被拒的专属错误 —— **可识别**是它的全部意义 (plan D-4)。
 *
 * 写手侧**不为它加任何 catch 分支**: 既有写手都已整轮 try/catch 且不上抛, 让它走既有路径
 * 落日志即可。dev 下每天因此多出的「被拒」日志是**刻意的可见信号** ——「你的本地进程正在
 * 试图采集」, 而事故当天最缺的正是这份可见性。
 */
export class MockCollectionRefusedError extends Error {
  constructor(
    readonly port: string,
    readonly method: string,
  ) {
    super(
      `[marketdata] 采集口 ${port}.${method}() 在 MARKETDATA_PROVIDER=mock 下拒绝提供数据 —— ` +
        '这是配置使然, 不是故障。mock 行情与真行情同形, 落进真表后无从分辨 (054); ' +
        '要跑真采集请设 MARKETDATA_PROVIDER=live。',
    );
    this.name = 'MockCollectionRefusedError';
  }
}

/**
 * `get` 陷阱必须对这些 key 返 `undefined` —— 它们是 runtime / 框架的**探测**, 不是业务调用。
 *
 * 🚨 **漏一个不是红, 是崩或挂**:
 * - 5 个 Nest lifecycle hook —— `@nestjs/core` 对**每个 provider 实例**做
 *   `isFunction(instance.onModuleInit)` (`hooks/on-module-init.hook.js:13`)。拒绝壳若返回一个
 *   函数, Nest 会认定它有生命周期钩子并**在 boot 时调用** ⇒ `kind=mock` 下全 boot 当场崩。
 * - `then` —— 返函数会让 JS 把拒绝壳当 thenable, `await` 它的代码**挂住而不是报错**。
 *   挂住不给红, 是这份清单里唯一一条连信号都没有的坑。`catch` / `finally` 同族一并放行
 *   (有些 `isPromise` 实现三个一起探)。
 * - 其余为序列化 / 调试 / 相等性探测 (`JSON.stringify` / logger 打印 / `util.inspect`)。
 *
 * symbol key 一律返 `undefined` (`Symbol.toStringTag` / `Symbol.iterator` / inspect custom 等
 * 全在此列), 故不必逐个登记。
 */
const INFRA_PROBE_KEYS: ReadonlySet<string> = new Set([
  'onModuleInit',
  'onModuleDestroy',
  'onApplicationBootstrap',
  'onApplicationShutdown',
  'beforeApplicationShutdown',
  'then',
  'catch',
  'finally',
  'constructor',
  'toJSON',
  'toString',
  'valueOf',
  'inspect',
]);

/**
 * 造一个按目标 port 类型标注的拒绝壳: 业务方法**一调即抛** `MockCollectionRefusedError`。
 *
 * 抛在**调用点**而非属性访问点是刻意的 —— ① 栈里能直接看见是哪个写手在采集; ② 未知的框架
 * 探测顶多拿到一个不会被调用的函数, 不至于把 boot 带崩 (denylist 的兜底)。
 *
 * @param portName 出现在错误消息里的端口名, 传 token 的 `description`。
 */
export function refusingCollectionPort<T extends object>(portName: string): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      if (typeof prop === 'symbol' || INFRA_PROBE_KEYS.has(prop)) return undefined;
      return (): never => {
        throw new MockCollectionRefusedError(portName, prop);
      };
    },
  });
}
