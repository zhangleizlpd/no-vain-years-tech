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

module.exports = withNativeWind(config, { input: './global.css' });
