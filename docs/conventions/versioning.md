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

manifest 起步值不能用 `0.0.0`(release-please 视为 "uninitialized",首次 release 直接跳 `1.0.0`;见 [ADR-0042 § 起步状态](../adr/0042-monorepo-release-strategy.md));`1.0.0` 只由正式上架时手动 `release-as` 触达(见下「上架路线」)。

## bump 规则(pre-1.0)

两 config 均设 `"bump-minor-pre-major": true`,**仅在 `version < 1.0.0` 时生效**:

| commit 类型                  | bump  | 示例            |
| ---------------------------- | ----- | --------------- |
| `fix`                        | patch | `0.8.0 → 0.8.1` |
| `feat`                       | minor | `0.8.0 → 0.9.0` |
| `feat!` / `BREAKING CHANGE:` | minor | `0.8.0 → 0.9.0` |

minor 不进位(`0.9.0 → 0.10.0 → …`),永远不会自动到 `1.0.0`;该 flag 的唯一作用是把 breaking change 从默认的 major bump 压成 minor,堵住「一个 `feat!` 把 pre-1.0 直接弹到 `1.0.0`」。

## CHANGELOG 可见性(哪些 type 会进 release notes)

两 config 均显式写死 `changelog-sections`(**不吃 release-please 默认**,因为默认表把 `refactor` 藏了):

| 可见                                               | 隐藏(仍计入发布内容,只是不出现在 notes)    |
| -------------------------------------------------- | ------------------------------------------ |
| `feat` `fix` `perf` `deps` `revert` **`refactor`** | `docs` `style` `chore` `test` `build` `ci` |

🚨 **「不在 notes 里」不等于「不在这个 release 里」。** release tag 打在 Release PR 合进 main 之后的那个 commit 上 ⇒ **那一刻 main 上的全部改动都进了这个版本**,不管它的 type 有没有被 notes 收录(实例:`a78ae9c8` refactor #194 在 `server-v0.36.4` 里,notes 只列了两条 Bug Fixes)。

⇒ `refactor` 放出来的理由:**带 DB migration 的改动经常是 `refactor`**(改列名 / 拆表),而读 notes 的人正是拿它判断「能不能回滚、要不要挑时间部署」;一次 `DROP COLUMN` 在 notes 里隐形 = 把回滚代价藏起来。`chore` 仍隐藏(基建噪声)⇒ **带 migration 的改动 MUST NOT 用 `chore`**,按实际性质取 `feat` / `fix` / `refactor`。

## 发版流程

1. commit 遵循 [Conventional Commits](./git-workflow.md#commit-消息)
2. release-please 监听 push to main,双线各自的 config 各起独立 Release PR,标题 `chore(main): release <component> X.Y.Z`,label `autorelease: pending: <component>`(两线 label 互斥):
   - server — 改 `apps/server/package.json` + `apps/server/CHANGELOG.md`
   - mobile — 改 `apps/mobile/package.json` + `apps/mobile/app.json` + `apps/mobile/CHANGELOG.md`
3. 维护者**手动 merge** Release PR(per [git-workflow.md § PR 合入](./git-workflow.md#pr-合入),AI agent 不接 auto-merge)
4. merge 触发组件化 tag `server-vX.Y.Z` / `mobile-vX.Y.Z` + GitHub Release
5. tag 触发下游:`server-v*` → `build-image.yml` → `deploy.yml`(`workflow_run`,链路 SoT [prod-deploy-rollback](../../ops/runbook/prod-deploy-rollback.md));`mobile-v*` → `release-android-internal.yml` / `release-android-apk.yml`(EAS / APK 构建,不部署)

配置文件(双线各自一套,per ADR-0042 §4;拆分根因在那里,不复述):

- `/release-please-config.server.json` + `/.release-please-manifest.server.json` — server 线(node)
- `/release-please-config.mobile.json` + `/.release-please-manifest.mobile.json` — mobile 线(expo)
- manifest 是该组件版本号 source of truth(release-please 自动改,`package.json` / `app.json` 的 version 随之同步,不手改)
- `/.github/workflows/release-please.yml` — push to main 触发,同 job 顺序跑两个 step,PAT-with-fallback token 策略(ADR-0042 §5)

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

阶段性节点不打 tag(per ADR-0042 §2):靠 `docs/private/plans/YYYY-MM/MM-DD-<slug>.md` 文档,git log 自然带 SHA;组件化 tag 只由 release-please 打。

## CHANGELOG 路径

`apps/server/CHANGELOG.md` / `apps/mobile/CHANGELOG.md` 各一份,release-please 自动维护。**不写根 CHANGELOG** — manifest mode 不原生支持聚合,自写脚本属过度设计。

## 上架路线(1.0.0)

正式上架前一次性手动 bump 到 `v1.0.0`(server + mobile 同步)。双 config 拆分后,**两个 config 各加一次** `release-as`:

```jsonc
// release-please-config.server.json
{ "packages": { "apps/server": { "component": "server", "release-as": "1.0.0" } } }

// release-please-config.mobile.json
{ "packages": { "apps/mobile": { "release-type": "expo", "component": "mobile", "release-as": "1.0.0" } } }
```

release-please 下次跑会按 `release-as` 强制 bump;ship 后删除两处 `release-as` 字段恢复自动 SemVer。
