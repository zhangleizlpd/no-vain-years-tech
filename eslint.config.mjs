import nx from '@nx/eslint-plugin';
import eslintConfigPrettier from 'eslint-config-prettier';

export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    // '**/dist-runtime-smoke': runtime-smoke 的 expo export 输出目录（自定义名，`**/dist` glob 命中不到）
    // —— 不忽略则本地跑过 runtime-smoke 后 mobile:lint 会误扫其 minified bundle（万级 no-var/no-unused-expressions）。
    //
    // 🚨 playwright 那两个输出目录（`outputDir` / reporter 产物，见 apps/mobile/playwright*.config.ts）
    //    必须忽略，坏法不是「多扫几个文件」而是**并发竞态**：PR 模板要求的
    //    `nx affected -t lint typecheck test build runtime-smoke` 把 lint 与 playwright 放进同一个
    //    invocation，playwright 边跑边增删 playwright-test-results，eslint 的目录遍历正好走进去 ⇒
    //    `ENOENT: scandir …/playwright-test-results`，**整个 lint target 崩掉**（不是报几条 lint 错，
    //    是 eslint 自己异常退出）。表现成随机红、重跑又绿，最容易被当成 flaky 放过去。
    //    2026-08-17 实撞：单跑 mobile:lint 绿，与 runtime-smoke 同轮跑就红。
    ignores: [
      '**/dist',
      '**/dist-runtime-smoke',
      '**/out-tsc',
      '**/playwright-report',
      '**/playwright-test-results',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      // Mono-level Nx project boundary (cross-project, tag-driven via scope:* tags).
      // Source of truth: specs/002-account-profile/plan.md § module_boundaries
      // (post-PR-3 ADR-0030: 4 workspaces — apps/{server,mobile} + packages/{api-client,types}).
      //
      // Business module → filesystem path mapping:
      //   - server: apps/server/src/<module>/** — flat module dir, NO layer subdirs
      //     (per ADR-0043; intra-server bounded-context boundaries are file-level,
      //      module-scoped, in apps/server/eslint.config.mjs per ADR-0032)
      //   - mobile: apps/mobile/app/(app)/(tabs)/<feature> + co-located feature code
      //
      // depConstraints below are tag-driven via `scope:*` Nx tags on each project.json.
      // PR-T2 (ADR-0040 L2 策略层) flipped this from "fallback-permitted" to default-deny:
      // all business projects (server / mobile / api-client / types) now have
      // explicit scope tags; the previous `sourceTag: "*"` fallback was removed so
      // any new project added without a tag will fail lint immediately (forcing the
      // author to declare the intended scope upfront).
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: ['^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$'],
          depConstraints: [
            // server-app — NestJS backend; consumes @nvy/types only; no mobile/UI surface.
            {
              sourceTag: 'scope:server-app',
              onlyDependOnLibsWithTags: ['scope:pkg-types'],
              bannedExternalImports: [
                '@nvy/api-client',
                'react',
                'react-native',
                'nativewind',
                'expo',
                'expo-*',
                'zustand',
              ],
            },
            // mobile-app — Expo client; consumes api-client + types (Orval-generated
            // typed client + shared types). auth/ui/theme/core inlined to
            // apps/mobile/src/ per ADR-0030 (5→2 packages).
            {
              sourceTag: 'scope:mobile-app',
              onlyDependOnLibsWithTags: ['scope:pkg-types', 'scope:pkg-api-client'],
              bannedExternalImports: ['@nestjs/*', '@prisma/client'],
            },
            // pkg-types — re-exports @prisma/client types; zero internal deps.
            {
              sourceTag: 'scope:pkg-types',
              onlyDependOnLibsWithTags: [],
              bannedExternalImports: ['@nestjs/*', '@nvy/api-client'],
            },
            // pkg-api-client — Orval-generated typed client; consumes @nvy/types only;
            // no Nest / Prisma / UI / auth.
            {
              sourceTag: 'scope:pkg-api-client',
              onlyDependOnLibsWithTags: ['scope:pkg-types'],
              bannedExternalImports: ['@nestjs/*', '@prisma/client'],
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      '**/*.ts',
      '**/*.tsx',
      '**/*.cts',
      '**/*.mts',
      '**/*.js',
      '**/*.jsx',
      '**/*.cjs',
      '**/*.mjs',
    ],
    // Checkstyle-equivalent semantic lint (per docs/private/plans/2026-05/
    // 05-22-meta-config-mono-migration.md § 2.2). 全 warn 不 error 避免
    // AI 协作场景下 PR 被小驼峰错误硬卡;M3 部署前看 baseline 数据决定收紧。
    rules: {
      // CyclomaticComplexity: Java Checkstyle 默认 10 / meta 12;TS 略宽 15
      // 因 React 声明式代码 + 状态机分支多。
      complexity: ['warn', 15],
      // MethodLength: Java Checkstyle meta 80;TS 150 因 React component
      // 整页常态。skipBlankLines + skipComments 减噪音。
      'max-lines-per-function': ['warn', { max: 150, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    // Naming convention — TS-only (@typescript-eslint/naming-convention 需类型上下文)
    files: ['**/*.ts', '**/*.tsx', '**/*.cts', '**/*.mts'],
    rules: {
      '@typescript-eslint/naming-convention': [
        'warn',
        { selector: 'default', format: ['camelCase'] },
        // 变量允许 camelCase / UPPER_CASE / PascalCase (React component / namespace)
        { selector: 'variable', format: ['camelCase', 'UPPER_CASE', 'PascalCase'] },
        // typeLike (class / interface / type / enum) → PascalCase
        { selector: 'typeLike', format: ['PascalCase'] },
        // 枚举成员 → UPPER_CASE (Java enum / DDD 状态机惯例,e.g. AccountStatus.ACTIVE)
        { selector: 'enumMember', format: ['UPPER_CASE'] },
        // 参数允许 _-prefix 表示 unused
        { selector: 'parameter', format: ['camelCase'], leadingUnderscore: 'allow' },
        // property null — 放过 API 返回的 snake_case 字段 + 配置对象 kebab-case
        { selector: 'property', format: null },
        // import name null — 第三方 lib 导出名不可控 (e.g. Dysmsapi/Tea SDK)
        { selector: 'import', format: null },
      ],
    },
  },
  {
    // Metro-bundled 面禁相对 `.js`/`.jsx` 扩展 import/re-export。
    // Metro web bundler 按字面找 `Button.js`(不回退 `.tsx`)→ 整 web bundle 500 + 白屏;
    // 而 tsc(moduleResolution: bundler)会把 `./x.js` remap 到 `x.tsx`,故 typecheck/单测
    // 全绿掩盖,只有 web build / e2e 暴露(login slice 实证:~/ui + @nvy/api-client barrel)。
    // barrel `export * from './x.js'` 是高发区,故 re-export 形态一并约束。
    //
    // 仅约束 Metro 侧:apps/mobile + @nvy/api-client(mobile-only,server 已 ban)。
    // apps/server / prisma-generated 是 Node-ESM 运行时,`.js` 是
    // 必需的,不在此列;@nvy/types 双端(server Node-ESM + mobile Metro)消费,亦不纳入。
    files: ['apps/mobile/**/*.ts', 'apps/mobile/**/*.tsx', 'packages/api-client/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportDeclaration[source.value=/^\\..*\\.jsx?$/]',
          message:
            "相对 import 用 extensionless:Metro web 无法解析 '.js'(tsc 会 remap 故 typecheck 假绿)。去掉扩展名。",
        },
        {
          selector: 'ExportAllDeclaration[source.value=/^\\..*\\.jsx?$/]',
          message:
            "相对 re-export 用 extensionless:Metro web 无法解析 '.js'(barrel `export *` 高发区)。去掉扩展名。",
        },
        {
          selector: 'ExportNamedDeclaration[source.value=/^\\..*\\.jsx?$/]',
          message: "相对 re-export 用 extensionless:Metro web 无法解析 '.js'。去掉扩展名。",
        },
      ],
    },
  },
  // 关掉与 Prettier 冲突的 ESLint 风格规则 — 必须放最后
  // (per https://github.com/prettier/eslint-config-prettier)
  eslintConfigPrettier,
];
