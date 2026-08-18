# Mobile EAS 发版 runbook（含双账号轮换 A/B）

> 人面向操作手册。**值的单一真相源在代码**：workflow 速查 `.claude/rules/github-workflows-catalog.md`、账号映射 `apps/mobile/eas-accounts.json`、发版策略 [ADR-0042](../../docs/adr/0042-monorepo-release-strategy.md) / 二进制部署 [ADR-0044](../../docs/adr/0044-mobile-binary-deployment.md)。本文只讲**怎么操作 + 怎么排障**，不复制数值。

## 1. 发版链路一览

`release-please` merge → `mobile-vX.Y.Z` tag → 触发 4 个 mobile workflow，gate 各异（deploy-web 恒发，其余见下）：

| workflow                       | profile / 产物                                            | gate                                                                                       |
| ------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `release-android-internal.yml` | 内测 APK（markets **ON**，sideload）                      | dev 期默认（`MOBILE_RELEASE_PHASE` ≠ public）；**认 `EAS_ACCOUNT` 开关**                   |
| `release-android-apk.yml`      | 公开 APK（markets OFF，上架）                             | 仅 `MOBILE_RELEASE_PHASE` == public；**钉死账号 B（caishen-ai，生产）**                    |
| `deploy-web.yml`               | Expo Web（markets **ON** 自测面）→ `app.shintongtech.com` | **恒发**（每个 `mobile-v*` tag，不受 phase；公开合规仅走 APP 商店面，per #526 2026-06-22） |
| `release-ios-simulator.yml`    | iOS 模拟器包                                              | **仅手动** `workflow_dispatch`（auto-tag 已关省额度）                                      |

`workflow_dispatch` 手动触发一律 bypass phase gate。

**内测包怎么进手机**：`release-android-internal.yml` 跑完后，run 的 **Summary 页**顶部有一条 EAS 安装直链（`https://expo.dev/artifacts/eas/*.apk`）——**无需登录**，手机浏览器打开即下即装；同 package 同 keystore ⇒ 覆盖升级不必卸载。同 run 底部那个 workflow artifact 是 **zip 且要登录 GitHub**，只作 14 天归档兜底，别拿它当分发口。

## 2. 双账号轮换 A/B（省 EAS Free 额度）

EAS Free = **15 Android + 15 iOS 构建/月/账号**，每月 1 号重置。额度记在 **project owner 账号**头上（不是登录谁），故轮换 = 切 project（owner+projectId）成对换 token，由一个开关统一驱动。

| slot | 账号                 | 角色                   | secret         |
| ---- | -------------------- | ---------------------- | -------------- |
| `a`  | `xiaocaishen`        | **内测 / 日常 dev**    | `EXPO_TOKEN`   |
| `b`  | `caishen-ai`（个人） | **生产（公开包钉死）** | `EXPO_TOKEN_B` |

> 映射实体在 `apps/mobile/eas-accounts.json`。**公开包 `release-android-apk.yml` 钉死 slot b（生产账号 B）**；内测 `release-android-internal.yml` 默认 slot a、认 `EAS_ACCOUNT` 开关可轮换分摊额度（公开链永不轮换）。

### 日常操作（就一条命令）

```bash
# A 的 15 个用完 → 切到 B
gh variable set EAS_ACCOUNT --body b
# 月初重置后 / 想用回 A
gh variable set EAS_ACCOUNT --body a
gh variable get EAS_ACCOUNT          # 查当前
```

切换只在 CI 构建那一刻 patch runner 上的 app.json，**main 永远停 slot a**。

### 本地手动出包

```bash
scripts/eas/switch-account.sh a|b|status   # 改本地 app.json + 校验 eas whoami 匹配
```

### 验证一次轮换确实走了 B

```bash
gh variable set EAS_ACCOUNT --body b
gh workflow run release-android-internal.yml
# 看 run 日志 "Select EAS account" step → slot=b owner=caishen-ai
# 看 build 日志 → https://expo.dev/accounts/caishen-ai/...（归属即证额度落 B）
gh variable set EAS_ACCOUNT --body a   # 验完翻回
```

## 3. 排障

| 症状                                                                                                                   | 真因                                                                                                           | 处理                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| expo.dev 看不到刚触发的 build                                                                                          | dashboard **按账号隔离**，你停在 `xiaocaishen` 视图看                                                          | 左上角账号下拉切到 **caishen-ai**（不是 `caishen-ais-team` org）→ 项目 → Builds。或直接查：`eas build:list`（需 app.json 指向该 project） |
| 切到 B 后 build 失败「Generating a new Keystore not supported in --non-interactive」                                   | B 是新 project，首次构建无 keystore                                                                            | 用一次**交互式** `eas build`（非 CI）让 EAS 生成；之后 CI `--non-interactive` 复用                                                        |
| 本地 `switch-account.sh` 警告 whoami≠owner                                                                             | 本地登录账号与目标 slot 不符（会烧错账号）                                                                     | `eas logout && eas login` 登对账号，或 `export EXPO_TOKEN=<对应账号 token>`                                                               |
| build 失败，`eas build:view <id> --json` 只有泛化 `EAS_BUILD_UNKNOWN_GRADLE_ERROR`，`logFiles[]` 用 curl+gunzip 读不出 | `logFiles[]` 内容是给 Expo web UI 解析器的二进制/编码流（magic `8b ff 7f`，非 gzip/zlib/brotli），本地不可解码 | 浏览器开 build 页（已登录）展开失败 phase（如 "Run gradlew"）看 gradle 真错；别花 tool call 试解码 logFiles                               |
| `eas config` 非交互跑挂 / `eas init` 建新 project 失败                                                                 | `eas config` 需显式 `-p android\|ios`（否则进交互 prompt）；`eas init` 非交互建新 project 需 `--force`         | 加对应 flag。`eas config` 输出 shape=`{buildProfile, appConfig}` 且平台配置 flatten 到 buildProfile 顶层（android.buildType→顶层）        |

## 4. 启用一个新账号 slot（一次性）

1. 登该账号：`eas login`
2. 在 `apps/mobile` 临时剥 owner+projectId（`jq 'del(.expo.owner)|del(.expo.extra.eas.projectId)'`），`eas init` 建 project，**抄下新 projectId**，再 `git checkout app.json` 还原
3. 填 `apps/mobile/eas-accounts.json` 对应 slot（owner + projectId）
4. expo.dev（登该账号）→ Account settings → Access tokens → 生成 → `gh secret set <对应 secret 名>`

## 5. 硬约束（上架前必读）

- 两账号各有**独立 keystore + 独立 remote versionCode 计数器**。跨账号 APK 签名不同 → **无法覆盖升级**（Android 拒装），versionCode 也会跳号。
- 故**内测轮换仅限 sideload**（卸载重装无碍）。**公开发布已锚定账号 B**（`release-android-apk.yml` 钉死 slot b，2026-06-19）：B 的 project keystore 即上架签名 → **首次公开出包前**，B 需用一次**交互式** `eas build` 生成 keystore（CI `--non-interactive` 不能新建）；**一旦首次公开发布，B 的 keystore 永久锁定**（Android 覆盖升级要稳定签名），**禁止再切换公开账号 / 在公开链加 `EAS_ACCOUNT` 轮换**。内测在 A、公开在 B，两账号 keystore 各自独立、**无需统一**（内测 sideload 不要求匹配公开签名；因从一开始就锚定 B 作公开，无 A→B 迁移 keystore 的问题）。
