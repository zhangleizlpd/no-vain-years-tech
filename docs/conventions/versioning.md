# 版本号 / 发版

mono 仓双线发版:`apps/server` + `apps/mobile` 各自独立 SemVer 版本线,均由 release-please 自动化驱动(per [ADR-0042](../adr/0042-monorepo-release-strategy.md))。

## 版本号规范

`apps/server` 与 `apps/mobile` **各自独立版本线**,均走 SemVer。`packages/*` + `scripts/*` 排除发版(`private: true` + `workspace:*` 软链)。

| 组件          | 版本线                                | 格式                        | 管理方式                                                                         |
| ------------- | ------------------------------------- | --------------------------- | -------------------------------------------------------------------------------- |
| `apps/server` | 源代码版本                            | SemVer `vMAJOR.MINOR.PATCH` | release-please 自动化(`apps/server/package.json`)                                |
| `apps/server` | API 版本                              | URI 前缀 `/api/v{n}/...`    | 手动,只在真 HTTP 契约 breaking 才升 vN;OpenAPI version 硬编码 `1.0`              |
| `apps/mobile` | Marketing 版本                        | SemVer `MAJOR.MINOR.PATCH`  | release-please 自动化(同步 `app.json#expo.version` + `apps/mobile/package.json`) |
| `apps/mobile` | iOS buildNumber / Android versionCode | 整数单调递增                | EAS Build 自动递增,release-please 不动                                           |
| `apps/mobile` | Expo `runtimeVersion`                 | 仅 native 代码变化时 bump   | 手动;用于 OTA 热更边界                                                           |

**起步版本**:server `0.0.1` / mobile `0.0.1`(均 pre-1.0,未正式上线)。第一个 `feat(*)` commit 触发 minor bump 到 `0.1.0`。M4 正式上架应用商店时 server + mobile 同步手动 `release-as: 1.0.0`,之后破坏兼容变更走 `v2.0.0` 和 `/api/v2/...`。

> ⚠ **manifest 起步值不能用 `0.0.0`**:release-please 把 `0.0.0` 当 "uninitialized" → 首次 release 直接跳 `1.0.0`(绕过 pre-major minor bump 默认)。`apps/{server,mobile}/package.json` 的 `version` 字段同样起步 `0.0.1`,保持与 manifest cross-consistency。详见 [ADR-0042 §Postmortem](../adr/0042-monorepo-release-strategy.md)。

## bump 规则(pre-1.0)

两 config 均设 `"bump-minor-pre-major": true`。该 flag **仅在 `version < 1.0.0` 时生效**,M4 手动 `release-as: 1.0.0` 后自动失效、恢复标准 SemVer。pre-1.0 各 commit 类型对应的 bump:

| commit 类型                  | bump  | 示例            |
| ---------------------------- | ----- | --------------- |
| `fix`                        | patch | `0.8.0 → 0.8.1` |
| `feat`                       | minor | `0.8.0 → 0.9.0` |
| `feat!` / `BREAKING CHANGE:` | minor | `0.8.0 → 0.9.0` |

`feat` 的 minor bump 是 `0.9.0 → 0.10.0 → 0.11.0 …`(decimal 不进位),永远不会自动到 `1.0.0`。**`bump-minor-pre-major` 的唯一作用**是把 breaking change 从 release-please 默认的 major bump(`→ 1.0.0`)压成 minor —— 堵住「一个 `feat!` commit 把 pre-1.0 版本直接弹到 `1.0.0`」的地雷。`1.0.0` 只由 M4 手动 `release-as` 触达(见下「M4 上架路线」)。

## CHANGELOG 可见性(哪些 type 会进 release notes)

两 config 均显式写死 `changelog-sections`(**不吃 release-please 默认**,因为默认表把 `refactor` 藏了)。可见 / 隐藏如下:

| 可见                                               | 隐藏(仍计入发布内容,只是不出现在 notes)    |
| -------------------------------------------------- | ------------------------------------------ |
| `feat` `fix` `perf` `deps` `revert` **`refactor`** | `docs` `style` `chore` `test` `build` `ci` |

🚨 **「不在 notes 里」不等于「不在这个 release 里」。** release tag 打在 Release PR 合进 main 之后的那个 commit 上 ⇒ **那一刻 main 上的全部改动都进了这个版本**,不管它的 type 有没有被 notes 收录。实例:`a78ae9c8`(refactor,#194)在 `server-v0.36.4` 里,而 0.36.4 的 notes 只列了两条 Bug Fixes。

⇒ 这就是 `refactor` 被放出来的理由:**带 DB migration 的改动经常是 `refactor`**(改列名 / 拆表这类),而读 release notes 的人正是拿它判断「这个版本能不能回滚、要不要挑时间部署」。一次 `DROP COLUMN` 在 notes 里隐形 = 把回滚代价藏起来。

🚨 **`chore` 仍然隐藏** —— 31 个历史 commit 用它,放出来 notes 会被基建噪声淹掉。⇒ **带 migration 的改动 MUST NOT 用 `chore`**,按实际性质取 `feat` / `fix` / `refactor`。

> 判据来源是实证不是默认表推断: `docs`(3) / `chore`(31) / `build`(1) / `test`(3) / `refactor`(6) 这些 type 都有 commit 触及过 `apps/server`,而 CHANGELOG 全史只出现过 `Bug Fixes` 与 `Features` 两个 section。

## 发版流程

由 [release-please](https://github.com/googleapis/release-please) 自动化驱动:

1. commit 遵循 [Conventional Commits](./git-workflow.md#commit-消息)
2. release-please 监听 push to main,各组件起独立 Release PR(`separate-pull-requests: true`):
   - `chore(server): release X.Y.Z` — 改 `apps/server/package.json` + `apps/server/CHANGELOG.md`
   - `chore(mobile): release X.Y.Z` — 改 `apps/mobile/package.json` + `apps/mobile/app.json` + `apps/mobile/CHANGELOG.md`
3. 维护者**手动 merge** Release PR(per [git-workflow.md § PR 合入](./git-workflow.md#pr-合入),AI agent 不接 auto-merge)
4. merge 触发组件化 tag `server-vX.Y.Z` / `mobile-vX.Y.Z` + GitHub Release
5. Plan 3 阶段:`if: ${{ steps.release_server.outputs['apps/server--release_created'] }}` 接 deploy hook

配置文件(双线各自一套,per [ADR-0042 §4](../adr/0042-monorepo-release-strategy.md)。拆分根因:单共享 manifest 下 server 发版会让 mobile 的 long-lived Release PR manifest 冲突且不自愈):

- `/release-please-config.server.json` + `/.release-please-manifest.server.json` — server 线(node),label `autorelease: pending: server`
- `/release-please-config.mobile.json` + `/.release-please-manifest.mobile.json` — mobile 线(expo),label `autorelease: pending: mobile`
- 每个 manifest 是该组件版本号 source of truth(release-please 自动改);两 manifest 写不同文件 → 两线发版永不相撞
- `/.github/workflows/release-please.yml` — push to main 触发,同 job 顺序跑两个 action step(各指自己 config/manifest),PAT-with-fallback token 策略

## 路径路由(不读 commit scope)

release-please 按 `packages` 配置的**路径**决定 bump 哪个组件,**不读 commit scope**:

| Commit 改动路径                                         | server bump | mobile bump |
| ------------------------------------------------------- | ----------- | ----------- |
| `apps/server/**` only                                   | ✅          | ❌          |
| `apps/mobile/**` only                                   | ❌          | ✅          |
| `apps/server/**` + `apps/mobile/**`                     | ✅          | ✅          |
| `packages/*` / `scripts/*` / `docs/**` / 根 config only | ❌          | ❌          |

因此 commit message scope 自由(`feat(account):` / `chore(repo):` 等),不被 release-please 约束;`commitlint.config.mjs` scope-enum 保持 `[0]` 不收紧。

## 阶段性节点

阶段性节点(Plan 1/2/3 / M0-M4)走 **GitHub Milestones**(用于 issue / PR 归类)+ `docs/private/plans/YYYY-MM/MM-DD-<slug>.md` 文档(git log 自然带 SHA);组件化 tag `server-vX.Y.Z` / `mobile-vX.Y.Z` 由 release-please 自动打。

## CHANGELOG 路径

各自一份:

- `apps/server/CHANGELOG.md` — release-please 自动维护
- `apps/mobile/CHANGELOG.md` — 同上

**不写根 CHANGELOG** — manifest mode 不原生支持聚合,自写脚本属过度设计。

## M4 上架路线

M4 正式上架前一次性手动 bump 到 `v1.0.0`(server + mobile 同步)。双 config 拆分后,**两个 config 各加一次** `release-as`:

```jsonc
// release-please-config.server.json
{ "packages": { "apps/server": { "component": "server", "release-as": "1.0.0" } } }

// release-please-config.mobile.json
{ "packages": { "apps/mobile": { "release-type": "expo", "component": "mobile", "release-as": "1.0.0" } } }
```

release-please 下次跑会按 `release-as` 强制 bump;ship 后删除两处 `release-as` 字段恢复自动 SemVer。
