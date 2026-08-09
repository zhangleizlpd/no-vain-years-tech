import baseConfig from '../../eslint.config.mjs';
import boundaries from 'eslint-plugin-boundaries';

/**
 * apps/server flat config.
 *
 * extends mono root (含 @nx/enforce-module-boundaries 跨 project boundary) +
 * 加 eslint-plugin-boundaries 文件级 bounded-context boundary (ADR-0032).
 *
 * PR-4 post-A-002 retro: split monolithic `auth` into 3 bounded contexts
 *   - security  platform infra (JWT + DB + Redis + common DTOs) — no business deps
 *   - account   Account aggregate + profile + account-bound auth guard
 *   - auth      phone-sms-auth 编排 (orchestrates account + security)
 *
 * Boundaries rules (module-level, single direction):
 *   auth → account → security
 *
 * Hexagonal layer subdirs (domain/application/infrastructure/web) were retired
 * in PR-4 and permanently removed by ADR-0043 (flat + anemic paradigm) — they
 * will NOT be reintroduced. Intra-module data-moat discipline (own-table-only)
 * is enforced by the ts-morph probe scripts/checks/check-server-moat.ts, not by
 * layer-based lint elements.
 */
export default [
  ...baseConfig,
  {
    files: ['src/**/*.ts'],
    plugins: { boundaries },
    settings: {
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
          project: './tsconfig.json',
        },
      },
      'boundaries/elements': [
        { type: 'security', pattern: 'src/security/**' },
        // integrations (058, ADR-0058): 平台层 — 跨 ctx 共享的外部 vendor I/O 适配器家
        // (LLM provider 首位)。与 security/ 同级基础设施层, 被业务 ctx 单向 import,
        // 自身不依赖任何业务 ctx (叶子方向)。
        { type: 'integrations', pattern: 'src/integrations/**' },
        { type: 'account', pattern: 'src/account/**' },
        { type: 'auth', pattern: 'src/auth/**' },
        { type: 'portfolio', pattern: 'src/portfolio/**' },
        // 023 (ADR-0053): 纯函数 rules 文件细分元素 — 必须排在 marketdata 通配前
        // (boundaries 元素按声明序首匹配); 文件级 pattern 须 mode:'full' (默认 'folder'
        // 按祖先目录匹配, 永不命中文件名 glob)。仅放行 alert → marketdata-rules 编译期
        // 纯函数复用 (deriveAdjustedBars 前复权口径单源); adapter/usecase/module 仍全禁。
        { type: 'marketdata-rules', pattern: 'src/marketdata/*.rules.ts', mode: 'full' },
        { type: 'marketdata', pattern: 'src/marketdata/**' },
        // optionsdesk (045, 第 10 ctx; ADR-0062 期权台锚管理 + 击球区雷达) — 声明序放在
        // marketdata 之后 (元素按声明序首匹配, 避免被上游通配抢匹配)。
        { type: 'optionsdesk', pattern: 'src/optionsdesk/**' },
        { type: 'alert', pattern: 'src/alert/**' },
        { type: 'chat', pattern: 'src/chat/**' },
        { type: 'ideation', pattern: 'src/ideation/**' },
        { type: 'agent-bridge', pattern: 'src/agent-bridge/**' },
        { type: 'app', pattern: 'src/{app,main}.ts' },
        { type: 'app', pattern: 'src/app/**' },
        { type: 'generated', pattern: 'src/generated/**' },
        { type: 'smoke', pattern: 'src/__smoke__/**' },
        { type: 'openapi', pattern: 'src/openapi.*' },
      ],
      'boundaries/include': ['src/**/*.ts'],
    },
    rules: {
      // v6 object-selector syntax (per eslint-plugin-boundaries v5→v6 migration).
      // v5 legacy `boundaries/element-types` + string `disallow` array
      // silently no-op'd under v6, hiding gate breach.
      'boundaries/dependencies': [
        'error',
        {
          default: 'allow',
          rules: [
            // security 是 base layer — 不依赖任何业务 context
            // (marketdata-rules 细分后须显式同禁, 维持 023 前围栏语义不变)
            {
              from: { type: 'security' },
              disallow: {
                to: {
                  type: [
                    'account',
                    'auth',
                    'portfolio',
                    'marketdata',
                    'marketdata-rules',
                    'alert',
                    'chat',
                    'ideation',
                    'agent-bridge',
                    'optionsdesk',
                  ],
                },
              },
            },
            // integrations (058, ADR-0058) 是平台层 — 像 security 一样被业务 ctx 单向 import,
            // 自身禁依赖任何业务 ctx (叶子方向)。可 import security 平台基座 (若 vendor 适配器
            // 需 Redis 等); LLM wire-format 类型 (Msg/ToolCall) 已上移至 integrations port,
            // chat 反向 import 合法 (业务 → 平台)。
            {
              from: { type: 'integrations' },
              disallow: {
                to: {
                  type: [
                    'account',
                    'auth',
                    'portfolio',
                    'marketdata',
                    'marketdata-rules',
                    'alert',
                    'chat',
                    'ideation',
                    'agent-bridge',
                    'optionsdesk',
                  ],
                },
              },
            },
            // account 仅依赖 security
            {
              from: { type: 'account' },
              disallow: {
                to: {
                  type: [
                    'auth',
                    'portfolio',
                    'marketdata',
                    'marketdata-rules',
                    'alert',
                    'chat',
                    'ideation',
                    'agent-bridge',
                    'optionsdesk',
                  ],
                },
              },
            },
            // auth 可依赖 security + account, 但不依赖 portfolio / marketdata / alert / chat (叶子)
            {
              from: { type: 'auth' },
              disallow: {
                to: {
                  type: [
                    'portfolio',
                    'marketdata',
                    'marketdata-rules',
                    'alert',
                    'chat',
                    'ideation',
                    'agent-bridge',
                    'optionsdesk',
                  ],
                },
              },
            },
            // portfolio (011, 第 4 ctx) 仅依赖 security + account (鉴权 guard 经
            // AccountModule export 复用), 不依赖编排层 auth / marketdata / alert / chat → 保 portfolio 为叶子
            {
              from: { type: 'portfolio' },
              disallow: {
                to: {
                  type: [
                    'auth',
                    'marketdata',
                    'marketdata-rules',
                    'alert',
                    'chat',
                    'ideation',
                    'agent-bridge',
                    'optionsdesk',
                  ],
                },
              },
            },
            // marketdata (015, 第 5 ctx) 是叶子 — 仅依赖 security + account (PrismaService
            // /Redis/ProblemDetailFilter + JwtAuthGuard/AccountIdThrottlerGuard 经 export 复用),
            // 不依赖编排层 auth / 用户业务域 portfolio / alert。本 feature 无消费者 (反向只读消费归 016+)。
            {
              from: { type: 'marketdata' },
              disallow: {
                to: {
                  type: [
                    'auth',
                    'portfolio',
                    'alert',
                    'chat',
                    'ideation',
                    'agent-bridge',
                    'optionsdesk',
                  ],
                },
              },
            },
            // marketdata-rules 细分自 marketdata (023, ADR-0053) — from 侧维持母元素同款
            // 禁边 (单向不成环: rules 纯函数不得反向感知业务消费方 alert)
            {
              from: { type: 'marketdata-rules' },
              disallow: {
                to: {
                  type: [
                    'auth',
                    'portfolio',
                    'alert',
                    'chat',
                    'ideation',
                    'agent-bridge',
                    'optionsdesk',
                  ],
                },
              },
            },
            // alert (021, 第 6 ctx; ADR-0052) 是叶子 — 仅依赖 security + account (鉴权
            // artefact 经 export 复用)。对 marketdata 仅 Q7-B Prisma 只读直查 (moat 探针管,
            // 无 import 依赖), 不依赖编排层 auth / 用户业务域 portfolio / marketdata。
            // 023 (ADR-0053): 唯一放行边 alert → marketdata-rules (纯函数编译期复用,
            // disallow 故意不含 'marketdata-rules'); marketdata 本体 (adapter/usecase/module) 仍禁。
            {
              from: { type: 'alert' },
              disallow: {
                to: {
                  type: [
                    'auth',
                    'portfolio',
                    'marketdata',
                    'chat',
                    'ideation',
                    'agent-bridge',
                    'optionsdesk',
                  ],
                },
              },
            },
            // chat (027, 第 7 ctx; ADR-0032 Q4 全新领域) 是叶子 — 仅依赖 security + account
            // (PrismaService + ProblemDetailFilter + 全局 ThrottlerModule + JwtAuthGuard/
            // AccountIdThrottlerGuard 经 export 复用)。不依赖编排层 auth / 任何用户业务域
            // (portfolio / marketdata / alert)。无人依赖 chat (叶子, 反向边已在各 ctx disallow 补)。
            {
              from: { type: 'chat' },
              disallow: {
                to: {
                  type: [
                    'auth',
                    'portfolio',
                    'marketdata',
                    'marketdata-rules',
                    'alert',
                    'ideation',
                    'agent-bridge',
                    'optionsdesk',
                  ],
                },
              },
            },
            // ideation (032, 第 8 ctx; ADR-0057 需求灵感澄清) 是叶子 — 仅依赖 security + account
            // (PrismaService + ProblemDetailFilter + 全局 ThrottlerModule + JwtAuthGuard/
            // AccountIdThrottlerGuard 经 export 复用) + integrations (LLM provider port,
            // vendor I/O 平台层 ADR-0058)。**禁** import chat 或任何用户业务域编排层
            // (auth / portfolio / marketdata / marketdata-rules / alert)。无人依赖 ideation
            // (叶子, 反向边已在各 ctx disallow 补)。
            {
              from: { type: 'ideation' },
              disallow: {
                to: {
                  type: [
                    'auth',
                    'portfolio',
                    'marketdata',
                    'marketdata-rules',
                    'alert',
                    'chat',
                    'agent-bridge',
                    'optionsdesk',
                  ],
                },
              },
            },
            // agent-bridge (第 9 ctx; ADR-0032 Q4 全新领域 — App→本地 agent 通用事件通路)
            // 是叶子且比其他叶子更精简 — 仅依赖 security 平台基座 (PrismaService 查自有
            // AgentQueueEvent 表 + JWT 签发委托 token + OutboxPublisher 消费上游事件)。
            // **禁** import account (队列端点用自有 WorkerAuthGuard 非用户 JWT) 及一切业务
            // 编排/领域 ctx。无人依赖 agent-bridge (叶子, 入队走 R3 Outbox 消费, 反向边已在
            // 各 ctx disallow 补)。
            {
              from: { type: 'agent-bridge' },
              disallow: {
                to: {
                  type: [
                    'account',
                    'auth',
                    'portfolio',
                    'marketdata',
                    'marketdata-rules',
                    'alert',
                    'chat',
                    'ideation',
                    'optionsdesk',
                  ],
                },
              },
            },
            // optionsdesk (045, 第 10 ctx; ADR-0062 期权台 — 锚管理 + 击球区雷达) 是叶子 —
            // 仅依赖 security 平台基座 (PrismaService 直查自有锚表/痕迹表 + ProblemDetailFilter
            // + 全局 ThrottlerModule) + account (JwtAuthGuard/AccountIdThrottlerGuard 经 export
            // 复用)。**唯一放行的业务读边 = marketdata** (行情 Instrument→DailyBar 只读直查 +
            // QuoteSnapshot 类型复用, Q7-B; disallow 故意不含 'marketdata')。**禁** 编排层 auth
            // 与其余业务域 portfolio / alert / chat / ideation / agent-bridge。无人 import
            // optionsdesk (叶子; marketdata 侧采集闸走 Q7-B Prisma 只读直查, 反向边已在各 ctx
            // disallow 补)。
            // 🚨 'marketdata-rules' **显式在禁列** (虽是 marketdata 细分, 但 boundaries 是
            // default:allow ⇒ 不列即静默放行)。这条禁令是 ADR-0053 sunset_trigger #2
            // (「第二个 ctx 申请 import 他 ctx 的 *.rules.ts → 重审是否升级为共享 package」)
            // 的**机器绊线**: 045 判定未命中 (雷达 spot 只取最新未复权收盘单点, 用不到
            // deriveAdjustedBars 前复权换算)。将来真要读时复权序列时, lint 会红 —— 那次
            // 改 allowlist 的动作就是该 trigger 的触发点。moat 探针覆盖不到这类
            // (纯函数 import 既非 Prisma 跨 ctx 读、也非跨 ctx DI 注入), 只有此处能拦。
            {
              from: { type: 'optionsdesk' },
              disallow: {
                to: {
                  type: [
                    'auth',
                    'portfolio',
                    'alert',
                    'chat',
                    'ideation',
                    'agent-bridge',
                    'marketdata-rules',
                  ],
                },
              },
            },
          ],
        },
      ],
      // Allow `_xxx` parameters / variables / caught errors as the conventional
      // "intentionally unused" marker — keeps method signatures stable when the
      // arg is part of a contract (e.g., timestamp threading) but the current
      // body does not yet consume it.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // test/**（IT + _support）与 src spec 同一套豁免 —— 测试代码档。
    // lint 接线 2026-08-03（矩阵 T-2 lint 半边）：`nx lint server` = `eslint src test`，
    // test/ 从此不再是 lint 盲区（typecheck 半边已由 tsconfig.spec.json include test/** 覆盖）。
    files: ['src/**/*.spec.ts', 'src/**/*.test.ts', 'src/__smoke__/**', 'test/**/*.ts'],
    rules: {
      'boundaries/dependencies': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
];
