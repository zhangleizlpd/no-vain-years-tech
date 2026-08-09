---
adr_id: ADR-0044
status: Accepted
applies_to: [apps/mobile]
sunset_trigger: |
  - iOS 阶段2 真正上架 App Store(非仅 TestFlight) → 重审 production profile + submit 配置 + 元数据/审核流程是否需独立 ADR
  - Android 从直分发 APK 转 Google Play / 国内应用商店上架 → 重审 buildType apk→aab + 签名托管 + submit 配置
  - 引入 EAS Update(OTA 热更) → 重审 runtimeVersion 策略 + 与 release-please version 的协作边界(本 ADR §4 仅覆盖 build-time 版本)
  - EAS CLI / eas.json schema 不向后兼容大版本(appVersionSource 语义变 / cli.version 字段废弃) → 重审 §4/§5
  - 迁出 EAS 云构建(self-host build / fastlane 自管) → 构建链路决策 §1 整体重审
---

# ADR-0044: Mobile Binary 部署形态 — EAS Build 云构建 + Android 直分发 APK + iOS 两阶段 + remote 版本源

- Status: Accepted (2026-05-24)
- Deciders: @zhangleizlpd
- Tags: deploy / mobile / build

## Context

服务端已上线 prod (`https://api.xiaocaishen.me`,Aliyun SWAS 已备案),[子 plan 1](../private/plans/2026-05/05-24-client-deploy-p1-cloudflare-web.md) 的 Web 入口已 live 于 `app.xiaocaishen.me`。Android + iOS 二进制打包随之启动,需锁定**构建链路 / 版本所有权 / CLI 交付形态**作为 [子 plan 3](../private/plans/2026-05/05-24-client-deploy-web-android-ios-master.md)(Android)+ 子 plan 4(iOS)的共享 baseline。

历史定位:

- [ADR-0025](0025-frontend-cloudflare-pages-expo-web.md) 锁 Web(Expo Web → CF Pages),明确把 mobile binary 部署 **defer**。本 ADR 承接该 deferred scope。
- [ADR-0042](0042-monorepo-release-strategy.md) 锁 release-please 双线发版。其 §Postmortem(line 160)在**「尚无 EAS」语境**下决定 `app.json` `expo.version` 保留 `0.0.0`、不手动 bump;并把「mobile EAS Build buildNumber / runtimeVersion 与 release-please 协作边界」列为 **Open Question**,defer 到「首次 Plan 2 mobile feature ship / 首次 mobile build」。本 ADR 即该时点,**关闭该 open question 的 build-time 半边**(OTA / runtimeVersion 半边仍 defer,见 Open Questions)。

本 ADR 落地于子 plan 2(mobile 地基 PR);子 plan 3/4 只消费,不重建 `eas.json`。

## Decision

### 1. 构建链路 = EAS Build 云构建(唯一正路)

- Android / iOS 二进制一律走 **EAS Build 云构建**(用户拍板 Option 1)。
- 国内网络上传慢 / flaky → **第一选择挂稳定可靠的国内代理**保住云链路(per memory `feedback_china_network_prefer_domestic_proxy`);`eas build --local` 仅作本机调试 / 代理仍不通的**次选灾备**;纯 `expo prebuild` 链路**永久流放**(managed workflow 不落地 native 工程)。
- 理由:EAS 托管 credentials / keystore + reproducible 构建环境,免维护本机 Xcode / Android SDK 链路。

### 2. Android — EAS 托管签名 + APK 直接分发

- 签名 keystore 由 EAS 首次 build **自动生成托管**(建议 `eas credentials` 导出备份)。
- `android.buildType: apk`(**非 aab**)→ 直接分发(EAS build page 链接 / 自托管 + 扫码)。
- **不上** Google Play / 国内应用商店(defer,见 `sunset_trigger`)。

### 3. iOS — 两阶段

- **阶段 1(now,无 Apple 账号)**:`preview` profile `ios.simulator: true` → simulator build(`.tar.gz`)→ `xcrun simctl install` → Simulator 登录主流程打 prod API(核心目标:验连通)。
- **阶段 2(gated)**:Apple Developer Program 注册($99/yr)+ App Store Connect app record → `production` profile device build → `eas submit` → TestFlight。App Store 正式上架(元数据 / 审核)**defer**。

### 4. 版本所有权边界 — `appVersionSource: remote`(关闭 ADR-0042 open question)

| 字段                                                                               | owner              | 机制                                                                                                             |
| ---------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `expo.version`(display = iOS `CFBundleShortVersionString` / Android `versionName`) | **release-please** | `expo` release-type 发版时写 `app.json`(per ADR-0042 §4)                                                         |
| `ios.buildNumber` / `android.versionCode`                                          | **EAS 远端**       | `cli.appVersionSource: "remote"` + 各 build profile `autoIncrement: true`,EAS 服务端计数器递增,**不写 app.json** |

- **一次性对齐**:子 plan 2 把 `app.json` `expo.version` `0.0.0 → 0.0.1` 对齐 [`.release-please-manifest.mobile.json`](../../.release-please-manifest.mobile.json)(2026-06-15 双 manifest 拆分前为根 `.release-please-manifest.json`;当时已是 `0.0.1`)。EAS 在 local / remote **任一模式**下,二进制 display 版本都读 `app.json` `version`,故此 reconcile 与 appVersionSource 选择无关、必做。
- **本节 supersede ADR-0042 §Postmortem(line 160)「`app.json` `expo.version` 留 `0.0.0`、不手动 bump」陈述**:该陈述成立于「`app.json` 仅作 release-please 的**写入目标**、无其他消费者」语境。EAS Build 引入后,`app.json` `version` 成为二进制 display 版本的**实时消费者**,一次性 reconcile 必要。**ongoing 所有权不变**(release-please 仍是 `version` 的唯一 writer);**无 race** —— buildNumber / versionCode 走远端,永不碰 `app.json`,故 EAS 与 release-please 不抢写同一文件字段。
- 因此 **不在 `app.json` 写静态 `ios.buildNumber` / `android.versionCode`**(remote 模式由远端管)。

### 5. eas-cli 交付 — `cli.version` 钉版本,不进 workspace 依赖

- `eas.json` `cli.version` 钉最低版本;执行用 `pnpm dlx eas-cli@<ver>` 或全局安装。
- 理由:EAS CLI 官方明确 **"strongly discouraged to install eas-cli as a project dependency due to potential dependency conflicts"**;本仓 `.npmrc` `shamefully-hoist=true`(per [ADR-0028](0028-monorepo-pnpm-policy.md))会把 eas-cli 庞大依赖树全部上浮根 `node_modules`,与 Metro / RN 依赖冲突风险高。`cli.version` 提供版本下限护栏,不引入依赖污染。

### 6. EAS monorepo 适配

- `shamefully-hoist=true`(ADR-0028)已让根 `node_modules` 扁平,满足 EAS 安装期 Metro 解析,无需额外 hoist 配置。
- 仓根 `.easignore` 裁剪上传(缩国内上传体积),但**保留全部 pnpm workspace 包目录**(`apps/*` / `packages/*` / `scripts/orchestrator` / `scripts/checks`)+ 根 `pnpm-lock.yaml` / `pnpm-workspace.yaml` / `.npmrc` —— EAS 跑 `pnpm install --frozen-lockfile` 校验**每个** workspace importer,缺任一目录即 break install。`.easignore` 只 trim 非 workspace 的 `docs/` / `specs/` / `ops/` / `.github/` / `.claude/` 等。
- `eas.json` 各 profile `env.EXPO_PUBLIC_API_BASE_URL` build-time inline 指向 prod(`preview` + `production` 均为 prod,因子 plan 3/4 smoke 是「装 preview build → 打 prod API 验连通」);`development` 不 inline,走 Metro dev server / `.env`。

### 7. 投资/行情 family 编译期门控 — `EXPO_PUBLIC_FEATURE_MARKETS`（合规 invariant）

合规方向 B（[06-14-launch-compliance-prep-master.md](../private/plans/2026-06/06-14-launch-compliance-prep-master.md) + [06-14-markets-feature-gate-mechanism.md](../private/plans/2026-06/06-14-markets-feature-gate-mechanism.md)）：公开发布版**不得展示任何交易所行情**。机制 = build-time flag `EXPO_PUBLIC_FEATURE_MARKETS`（代码默认 OFF/fail-safe，`~/core/feature-flags.ts`），按 profile 注入：

| profile                                   | `EXPO_PUBLIC_FEATURE_MARKETS` | 用途                                                   |
| ----------------------------------------- | ----------------------------- | ------------------------------------------------------ |
| **`production`**                          | **`"false"`**                 | 🔒 **公开/商店构建 = markets OFF（合规硬约束，勿改）** |
| `internal`（新增，distribution:internal） | `"true"`                      | 内测 sideload（markets ON，永不上商店）                |
| `preview`                                 | `"true"`                      | iOS 模拟器冒烟（全功能）                               |
| `development`                             | `"true"`                      | 本地 dev-client                                        |

- **🔒 Invariant**：`production` profile 是上商店的唯一来源，其 `EXPO_PUBLIC_FEATURE_MARKETS` **必须为 `"false"`**。新增任何「会上商店」的 profile 同样必须 off。改动需回 06-14 合规 plan 复核。
- build-time 内联 → OTA 翻不动 → 公开构建恒 off（与 §Open Questions 的 OTA 半边对齐）。
- 内测 markets-on 构建走独立 workflow `release-android-internal.yml`（仅 `workflow_dispatch`，产物作 artifact，与 `release-android-apk.yml` 的公开 production 构建严格分离）。
- dev/test/web-export 链（`nx serve|build|e2e|runtime-smoke|e2e-real-backend`）在命令内显式 `EXPO_PUBLIC_FEATURE_MARKETS=true`（apps/mobile/project.json），保既有 portfolio/alert e2e 全功能验证 + web 自用版含行情。

## Consequences

- **子 plan 2(mobile 地基 PR)实装**:`apps/mobile/assets/` 复制 4 图标 + `app.json` version `0.0.1` + `apps/mobile/eas.json` 全 profile + 仓根 `.easignore` + `eas login`(user)/ `eas init`(agent 回填 `extra.eas.projectId`)。
- **子 plan 3(Android)/ 子 plan 4(iOS)** 消费本 ADR 的 profile,不重建 `eas.json`(避免并行编辑冲突)。
- **联动 amend**:[ADR-0042](0042-monorepo-release-strategy.md) Open Questions 中「mobile EAS Build buildNumber / runtimeVersion 与 release-please 协作边界」标 **Resolved by ADR-0044**(build-time 半边;OTA 半边仍 open)。
- `.easignore` 正确性的**最终验证随子 plan 3 首个 `eas build --profile preview`**(无 dry-run upload 命令)。

## Trade-offs

- **`appVersionSource: remote` → buildNumber 不在 git 可见** —— 需 `eas build:version:get` / EAS dashboard 查。接受:换来零 git churn + 不与 release-please 抢写 `app.json`,且 EAS 自管递增免手维护。
- **`cli.version` 钉版本而非 lockfile 锁** —— 本机 / CI 各自需有 eas-cli(dlx 缓存 / 全局),非 bit-for-bit 复现。接受:避免污染 `shamefully-hoist` 根树(Expo 官方明确建议),`cli.version` 已提供版本下限护栏。
- **APK 直接分发** —— 无商店自动更新 / 分发渠道。接受:PoC 阶段直分发最快验证用户路径,上架 defer。
- **EAS 云构建依赖外网** —— 国内上传 flaky。接受:国内代理优先 + `--local` 灾备(§1)。

## Open Questions

- **EAS Update(OTA 热更)引入后的 `runtimeVersion` 策略 + 与 release-please `version` 的协作** —— 本 ADR 仅覆盖 **build-time** 版本;OTA defer(承接 ADR-0042 原 open question 的 `runtimeVersion` 半边)。
- ~~**CI 自动化 `eas build --non-interactive`(GitHub Actions)** —— 稳态后再接,本 ADR 不预留代码(与 master plan Out of Scope 一致)。~~ **Resolved(2026-05-30)**:Web 自动部署接 `mobile-vX.Y.Z` tag 后(`.github/workflows/deploy-web.yml`,对齐 server `server-vX.Y.Z` 发版闸),Android APK 同 tag 触发落地于 `.github/workflows/release-android-apk.yml` —— GHA runner `eas build -p android --profile production --non-interactive --wait` 云构建签名 APK → `eas build:download` → `gh release upload` 挂到该 tag 的 GitHub Release。**§4 版本边界不变**:`expo.version` 仍 release-please 唯一 writer、EAS 只读;`versionCode` 仍 remote 自增。前置 owner 配 repo secret `EXPO_TOKEN`(robot access token)。GHA runner 在境外天然绕 §1 的国内上传 flaky(代理/`--local` 灾备仅本机仍需)。OTA 半边仍 open(上)。

## References

- [客户端部署 master plan](../private/plans/2026-05/05-24-client-deploy-web-android-ios-master.md) — 4 子 plan 拆分 + 跨子 plan 契约
- [子 plan 2 — Mobile binary 共享地基](../private/plans/2026-05/05-24-client-deploy-p2-mobile-foundation.md) — 本 ADR 落地 plan
- [ADR-0042](0042-monorepo-release-strategy.md) — release-please 双线;本 ADR §4 关闭其 buildNumber 边界 open question 并 supersede 其 postmortem「不 bump」陈述
- [ADR-0025](0025-frontend-cloudflare-pages-expo-web.md) — Web 部署(本 ADR 承接其 deferred 的 mobile binary scope)
- [ADR-0028](0028-monorepo-pnpm-policy.md) — `shamefully-hoist` pnpm 策略(§5/§6 依据)
- [EAS CLI README — project dependency 不推荐](https://github.com/expo/eas-cli)
- [EAS app versions — appVersionSource local vs remote](https://docs.expo.dev/build-reference/app-versions/)
