const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
config.resolver.disableHierarchicalLookup = true;

// 🚨 issue #625 — fold EXPO_PUBLIC_* values into the Metro transform cache key.
// babel-preset-expo statically INLINES `process.env.EXPO_PUBLIC_*` at transform
// time, but Metro's transform-cache key OMITS those values (that's the root
// reason Expo needs `expo export --clear` after an env change). So two
// `expo export`s with DIFFERENT EXPO_PUBLIC envs that share one Metro cache
// (e.g. `mobile:build` no-OSS vs `mobile:runtime-smoke` with OSS, or markets-ON
// vs markets-OFF) cross-contaminate: a cache hit reuses the other build's
// inlined value. CI hit this when `nx affected -t build runtime-smoke` ran both
// concurrently — the served runtime-smoke bundle lost EXPO_PUBLIC_OSS_PUBLIC_BASE_URL
// and only the image specs (FR-009/FR-010) failed.
//
// Mixing a hash of every EXPO_PUBLIC_* value into `cacheVersion` puts the omitted
// inputs BACK into the cache key (the Bazel "env is part of the action key"
// principle): differing public env → different keys → no collision, no poisoning,
// regardless of concurrency or scheduling. Same env → same key → cache reuse is
// preserved. Class-immune: any future divergent-env export is covered
// automatically, with no per-target config.
const publicEnv = Object.keys(process.env)
  .filter((k) => k.startsWith('EXPO_PUBLIC_'))
  .sort()
  .map((k) => `${k}=${process.env[k]}`)
  .join('\n');
const publicEnvHash = crypto.createHash('sha1').update(publicEnv).digest('hex');
config.cacheVersion = `${config.cacheVersion ?? '1.0'}|expo-public:${publicEnvHash}`;

// 🚨 issue #647 — the #625 `cacheVersion` key-busting above stops a divergent-env
// cache *hit* from reusing the wrong inlined value, but it does NOT stop a
// concurrency race on the cache STORE itself. Metro keeps BOTH of its on-disk
// caches — the transform cache (`cacheStores` FileStore) and the file-map / haste
// cache (`fileMapCacheDirectory`) — under a SHARED `os.tmpdir()` path with no
// per-process namespacing and no locking (facebook/metro#331). When
// `nx affected -t build runtime-smoke` runs both exports concurrently,
// `mobile:runtime-smoke`'s `expo export --clear` resets that shared cache tree
// mid-bundle, and `mobile:build`'s resolver then fails on modules that exist on
// disk → `Unable to resolve module ./generated/…`. cacheVersion can't help: it
// only namespaces the KEY inside the one shared dir that --clear wipes wholesale.
//
// Fix per Metro's own guidance (metrobundler.dev/docs/caching): give each
// divergent-env export its own cache dir. Root BOTH caches in a per-publicEnvHash
// subdir — differing public env → different dirs → `--clear` can only touch its
// own tree, never the concurrent build's. Same env → same dir → cache reuse
// preserved. Concurrency kept (no serialization); class-immune like #625.
const cacheRoot = path.join(os.tmpdir(), `metro-cache-nvy-${publicEnvHash}`);
config.cacheStores = ({ FileStore }) => [new FileStore({ root: cacheRoot })];
config.fileMapCacheDirectory = cacheRoot;

// 🚨 `expo start --web`(= `mobile:e2e` 的 webServer)起来后整屏白 —— entry bundle 求值
// 阶段就抛 `TypeError: Cannot read properties of undefined (reading 'default')`,一行
// UI 都没渲染。崩点在 Metro 自己的 HMRClient:
//
//     const prettyFormatFunc = typeof prettyFormat.default === 'function'
//       ? prettyFormat.default
//       : prettyFormat.default.default;   // ← prettyFormat.default 是 undefined
//
// 三个条件叠出来的,缺一不可,全在本仓成立:
//   1. `.npmrc` 的 shamefully-hoist=true 把 pretty-format@30 摊到 root node_modules。
//      叠加下面的 disableHierarchicalLookup + nodeModulesPaths,Metro 必然解析到它
//      (apps/mobile 侧没有这个包,直接落根)。27/29 无此问题 —— 它们没有 ESM 产物。
//   2. HMRClient 用 ESM `import prettyFormat from 'pretty-format'`。Metro 的 package
//      exports 解析对 ESM import 走 `import` 条件,命中 30.x 才新增的 `build/index.mjs`。
//   3. 那个 .mjs 是 `import cjsModule from './index.js'` 的薄包装,按 **Node** 的 CJS
//      interop 语义写的(cjsModule === module.exports)。Metro 用 **Babel** interop 编译
//      它,而 index.js 打了 `__esModule` 标记 → cjsModule 变成 module.exports.default,
//      整层错位一格:`export default cjsModule.default` 编译成 `format.default`,是
//      undefined。于是 HMRClient 那两个分支同时落空,读 undefined 的 `.default` 抛错。
//
// 只影响 dev bundle —— HMRClient 是 dev-only,`expo export` 的产物里没有它。这正是
// `mobile:build` / `mobile:runtime-smoke` 一直绿、只有 `mobile:e2e` 现形的原因。
//
// 修法取最小面:只把 `pretty-format` 这一个 specifier 钉回它的 CJS 入口,绕开那个错位
// 的 .mjs 包装。走 require.resolve(即 `require` 条件)而不是硬写 build/index.js,这样
// 27/29/30 任一版本都对。刻意不用 `unstable_enablePackageExports = false` 那种总开关:
// bundle 里其余 .mjs(zustand / react-hook-form / tslib / ...)都是真 ESM,没有这层 CJS
// 包装,本来就是好的,不该被连坐。
//
// ⏳ 上游修好(HMRClient 认第三种形状,或 pretty-format 去掉错位的 .mjs)后即可删。
//
// 🚨 必须设在 withNativeWind() **之前** —— 它内部的 react-native-css-interop/metro 会
//    先捕获 `config.resolver.resolveRequest` 当 originalResolver 再链式调用;设在之后
//    会被整个盖掉。
const prettyFormatCjsEntry = require.resolve('pretty-format', { paths: [workspaceRoot] });
const upstreamResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'pretty-format') {
    return { type: 'sourceFile', filePath: prettyFormatCjsEntry };
  }
  return (upstreamResolveRequest ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = withNativeWind(config, { input: './global.css' });
