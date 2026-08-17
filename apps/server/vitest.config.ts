import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

const swcPlugin = swc.vite({
  // 不读项目 .swcrc（项目 .swcrc exclude *.spec.ts，vitest 需要编译 spec）
  swcrc: false,
  module: { type: 'es6' },
  jsc: {
    parser: { syntax: 'typescript', decorators: true, dynamicImport: true },
    transform: { legacyDecorator: true, decoratorMetadata: true },
    target: 'es2021',
    keepClassNames: true,
  },
});

// 🚨 两个 project 共用这一份 —— 别在任一 project 里再写第二份。任何一项只落在一边，
// 都会变成「同一条命令在 src/ 和 test/ 下行为不同」的静默分叉。
// 出网探针（默认不挂，零成本）。开启后拦 socket / DNS / 子进程，用**运行时**证据校验
// testing.md 的 size 判据 —— 静态守卫扫 import，看不见动态调用，只能给必要条件。
const outboundProbe = process.env.NVY_OUTBOUND_PROBE ? ['./test/_support/outbound-probe.ts'] : [];

const sharedTestOptions = {
  globals: true,
  // 🚨 `quiet-logger` 与下面 `env.LOG_LEVEL` 是**同一件事的两半**，缺一半等于没做：
  // 前者管 `new Logger()`（Nest 内建 ConsoleLogger），后者管 pino。生产靠 main.ts 的
  // `useLogger` 把两套合一，测试里不合一 —— 详见 quiet-logger.ts 顶部那张表。
  setupFiles: [...outboundProbe, './test/_support/quiet-logger.ts'],
  environment: 'node' as const,
  exclude: ['node_modules', 'dist'],
  // 🚨 teardown 的超时预算。**这是一整类「随机 flake」的系统性根因**（2026-08-02 量化）：
  // 起容器的 188 个文件里 **173 个**给 beforeAll 写了 60_000/180_000，却把 afterAll
  // 留在 vitest 的 **10s 默认值** —— 而全量并行时拆容器远超 10s，于是 `afterAll` 撞
  // `Hook timed out in 10000ms`，表现为「某个与本次改动毫无关系的文件红了」。
  // 同日在全量门里实测撞到 4 次，每次都是不同文件、单跑必绿
  // （如 marketdata.flow-orchestration 单跑 4.86s、calendar-044.sanity-gate 单跑 14.65s）。
  // 代价：真正挂死的 hook 从 10s 变成 60s 才失败 —— 用这个换掉整类假红，划算。
  // ⚠️ 共享 PG 落地后 `test/` 侧已不再起 188 次容器，本值可在 P4 后续重新评估；
  // 但 `src/` 下仍有 40 个文件各起自己的容器，现在还不能降。
  hookTimeout: 60_000,
  // 🚨 单条 `it` 的超时预算 —— 与上面 hookTimeout **同构**的一类假红, 只是落在 it 侧。
  // 本仓 24 条 it 在单个用例里串行跑 ≥20 次真栈往返（18 条是测试自己 `for` 循环逐次打
  // Fastify inject —— 几乎全是限流边界用例, 要打满桶就得真发 N+1 次请求; 另 6 条播 ≥20 行
  // 再让实现逐行处理）, 空闲时约 1s, 但全量并行满载时越过 vitest 的 **5s 默认值**, 表现为
  // 「一条与本次改动毫无关系的测试红了」。2026-08-16 本机连跑两轮各红一条**不同**的:
  // anonymize.us7 的「批次 >100」实测 **5077ms**（超线 1.5%）、devices.us4-rate-limit 的
  // 「list per-IP 第 101 次」; 加 `--parallel=1` 消掉 nx 目标间资源争抢后同一套件全绿
  // ⇒ 负载敏感的临界, 不是代码回归。
  // 为什么全局提一档而不是逐条加参数: **逐条在仓内已经试过, 而且漏了**。24 条里只有 4 条写了
  // 显式 `15_000`, 且 watchlist.us1-us2.it.spec.ts 同一文件内 61 次那条补了（:434）,
  // **紧挨其上**的 121 次那条（:425, 往返数翻倍）却裸奔; watchlist-status.it.spec.ts:191
  // 的 121 次同样裸奔 —— 漏补的恰是更重的那条。逐条的前提是「写的人会记得补」, 仓内证据是不会。
  // 取值 15_000 不是新拍的, 就是那 4 条既有显式值, 本次只是把散落字面量升成默认。
  // 代价: 真正挂死的 it 从 5s 变成 15s 才失败 —— 用这个换掉整类假红, 同 hookTimeout 的取舍。
  // ⚠️ 可以降回来的条件: 这 24 条不再靠「真发 N 次请求」表达（限流桶状态可直接注入, 或阈值
  // 做成 per-test 可配、让 N 降到个位数）—— ≥20 次串行这一类消失后, 本值可回落。
  testTimeout: 15_000,
  // 027 T007: deepseekConfig 进 SecurityModule load 数组后, 所有 boot-AppModule IT
  // 在 .parse() 时要求 DEEPSEEK_API_KEY 非空。给一个测试占位 key 让全部 IT boot 过
  // (单点修)。真 DeepSeek 连通走 env-gated RUN_LLM_IT (T008), 占位 key 不实际外呼。
  env: {
    DEEPSEEK_API_KEY: 'test-deepseek-placeholder-key',
    MINIMAX_API_KEY: 'test-minimax-placeholder-key',
    // 测试套件对 vendor 数据源**恒 mock**, 不看 shell 环境 (hermetic)。没有这行时
    // `marketdataConfig` 只在 `MARKETDATA_PROVIDER` **整个变量缺失**时才落 mock
    // (054 起非法值与空串一律 boot 抛); worktree 的 .envrc 继承主仓 server .env 会把 `=live` 带进 shell, 于是
    // config 走 live 分支、缺 LIXINGER_TOKEN 等 → 在 Nest DI 实例化阶段 ZodError, 74 个
    // boot-AppModule IT 集体红且报错点离真因很远 (2026-08-02 踩过)。
    // 🚨 真 vendor 联调不靠改这里, 走 env-gated RUN_*_IT (同 DEEPSEEK 占位的处置)。
    MARKETDATA_PROVIDER: 'mock',
    // 🚨 **boot-required 占位，缺了不是「少个变量」而是整文件 33 个 test 全 skipped。**
    // `redis.config.ts` 的 `url` 是必填 `.url()`；而**把 `REDIS_CLIENT` stub 掉并不能
    // 阻止 `redisConfig` 被实例化** —— 模块图里仍有别的 provider 注入它 ⇒ 缺值就在 DI 期
    // ZodError，`beforeAll` 秒炸。
    // ⚠️ 而这个坑**本地永远看不见**：dev shell 里有真 `REDIS_URL`，把缺失盖得死死的。
    // 2026-08-17 实撞：059 的 IT 因此本地四轮全绿 / CI 四轮全红，查了四轮 CI 才定位
    // （CI 侧还取不到失败文本，见下方 reporters 那段）。
    // 📌 放这里而不是各 spec 自己写一行：原先 7 个文件各抄一份
    // `process.env.REDIS_URL = 'redis://127.0.0.1:6399'`，第 8 个人忘写就再炸一次 ——
    // 那不是纪律问题，是缺省值缺席。真要连 Redis 的 spec 照旧在 beforeAll 里赋
    // `stores.redisUrl`，赋值在 boot 之前，覆盖得掉本默认值。
    // 恒不连（6399 无人监听）是刻意的：真需要 Redis 的走 `setupIsolatedStores()`。
    REDIS_URL: 'redis://127.0.0.1:6399',
    // 🚨 测试里把 pino 压到 error —— **这不是「少打点日志」的洁癖，是可诊断性**。
    // 默认 info 下 pino-http 对每个请求打一条整条 req/res JSON(单条可达 3.7KB),
    // 一轮 IT 就是 ~200 条 / 140KB, 占整份输出的近四成。而 GitHub 的 job log 端点
    // 只回一个**有限窗口**, 噪声挤掉的正是失败时真要看的东西 ——
    // 2026-08-17 实撞: server-test 在 CI 上连续两次红, 而日志里连 vitest 的汇总行
    // 都取不到(对照过一次**成功**的跑, 同样取不到 ⇒ 是端点行为不是本次异常)。
    // ⚠️ 取 `error` 而不是 `fatal`/`silent`: 实测本地一轮里 pino 全部 202 行都是
    // level 30(info), 40/50/60 各零行 ⇒ 压到 error **一条现有信号都不损失**,
    // 而将来真出 5xx 时那条 error 照打。`silent` 还得动 app.config 的 zod 值域, 不值。
    LOG_LEVEL: 'error',
  },
};

export default defineConfig({
  test: {
    // 🚨 **CI 上必须显式带 `github-actions`，否则 CI 失败在 GitHub 侧不可见。**
    //
    // vitest 的 `github-actions` reporter（annotations + Job Summary + 行内标注）**只在
    // 「没有显式配置 reporters」时才自动启用**（官方文档原话：configure reporters 之后
    // 需要自己把它加回来）。而本仓原先在 `project.json` 写死 `vitest run --reporter=default`
    // —— 那一句正好把它关掉了。
    //
    // 后果不是「少点好看的标注」，是**失败根本取不回来**：nx 在 CI 上不转发完整 task 输出，
    // 且 `--output-style` 在 CI 被直接忽略（nrwl/nx#15570，`if (isCI()) return false`，
    // closed as not planned）⇒ job log 里既没有 vitest 汇总也没有失败块。
    // 2026-08-17 实撞：server-test 连续三次红，失败文本从 CI 侧完全取不到，
    // 靠逐行滤噪才在正文里找出是哪个文件。annotations 是绕开 nx 输出层的唯一通路。
    //
    // ⚠️ 只在 GitHub Actions 上加：本地跑时它会打 `::error` 这类 workflow 命令行，是噪声。
    reporters: process.env.GITHUB_ACTIONS ? ['default', 'github-actions'] : ['default'],

    // 🚨 拆两个 project **不是为了归类好看**，是为了保住快速内环。
    // vitest 只为「本轮真有 spec 命中」的 project 初始化 globalSetup（root project 除外，
    // 而 root 这里蓄意不挂 globalSetup）。于是：
    //   · 单跑一个 src/ 单测 → `it` 无命中 → 共享 PG 根本不起 → 实测 0.56s
    //   · 把 globalSetup 直接挂到 root/`unit` 上 → 每次单测单跑白起一个 PG → 实测约 4s（6× 退化）
    // 改这段前先想清楚这条语义，别把 globalSetup 往上提。
    //
    // 🚨 划线不是「文件在 src/ 还是 test/」，是「要不要容器」（T-1，2026-08-02 落地）：
    // `src/` 下 46 个 spec 各自起 PG / Redis 容器却不带 `.it.` 标记，于是既进不了 `it` 的
    // 共享 PG（拿不到收益），又让 `unit` 这条「快速内环」名不副实（跑它必须有 Docker）。
    // 现在改成**按后缀**分：`*.it.spec.ts` 一律归 `it`（无论住 src/ 还是 test/），
    // `unit` 则是**零容器**的硬不变量，由 scripts/checks/check-test-size.ts 钉死。
    // ⚠️ 保留在 `src/` 而不搬进 `test/` 是**蓄意的**：Narrow scope 与被测对象 colocate
    // （testing.md §3）。当年的另一半理由「test/ 是静态检查盲区」已失效 —— T-2 两半边
    // 于 2026-08-03 全闭环（typecheck + lint 均覆盖 test/**），但判定不回改：搬动零收益。
    projects: [
      {
        plugins: [swcPlugin],
        test: {
          ...sharedTestOptions,
          name: 'unit',
          include: ['src/**/*.{spec,test}.ts'],
          exclude: [...sharedTestOptions.exclude, 'src/**/*.it.spec.ts', 'src/**/*.vendor.spec.ts'],
        },
      },
      {
        plugins: [swcPlugin],
        test: {
          ...sharedTestOptions,
          name: 'it',
          include: ['test/**/*.{spec,test}.ts', 'src/**/*.it.spec.ts', 'src/**/*.vendor.spec.ts'],
          globalSetup: ['./test/_support/global-setup.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/**/*.test.ts', 'src/main.ts', 'src/generated/**'],
      // 🚨 蓄意无 thresholds：曾配 60/50 门槛, 但全仓从没有任何自动化调用传过 --coverage
      // —— 配了不跑的门槛是「看起来有覆盖率治理」的装饰, 且哪天有人无意间接通就是一片
      // 突然的红。coverage 保留为 ad-hoc 观测工具 (`nx test server -- --coverage`)；
      // 要真设门, 先让它在某条自动化里真跑起来、用实测数据定阈值
      // (纪律见 docs/conventions/test-environment-matrix.md §3)。
      // 旧值留档: lines 60 / branches 50 (M1.1 JaCoCo 镜像)。
    },
  },
});
