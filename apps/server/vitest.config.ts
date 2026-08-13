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
  setupFiles: outboundProbe,
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
  },
};

export default defineConfig({
  test: {
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
