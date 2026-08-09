---
name: 'config-add'
description: '加一个 server 配置项（env var）时，自动把它落到所有该落的位置——非密一次性全写明文位置，密文 run_in_background 开 zed/sops 让你填真值，收尾跑 check-env-sync 验绿。触发：用户提"加配置项 / 新增 env var / 加个 API key / 加 server config / config-add"，或 /implement 新建 process.env.X 后。'
argument-hint: '[KEY_NAME]（可选；省略则扫 git diff + config 找新 process.env.X）'
user-invocable: true
disable-model-invocation: false
---

# config-add — 新增 server 配置项一键落位

把「加一个 server 配置项不是改一行——是一条 boot-path」自动化。**单一真相**是 path-rule
[`.claude/rules/config-env-sync.md`](../../rules/config-env-sync.md)（9 位置 + secret 路由 + Check A–G）；本 skill 是它的**可执行版**：一次性写全所有位置，密文用 zed 让用户填，不逐个问。

> ⚠️ 本 skill 改 `secrets.enc.env` 依赖本地有 `sops` + `age` 私钥（`~/.config/sops/age/keys.txt`）+ `zed`。CI/headless 无 zed → 密文填写本就只能人工本地做，密文分支仅本地交互场景用。

## 流程（按序执行）

### 1. 发现要加的 key

- 有 `$ARGUMENTS`（KEY 名）→ 用它。先确认它在 `apps/server/src/config/<x>.config.ts` 有 `process.env.KEY` + zod schema（出生地 #1，前置；没有先让用户/在 config 里加，本 skill 不创造配置语义）。
- 无参数 → 跑 `pnpm tsx scripts/checks/check-env-sync.ts`，读它报的 `process.env.<KEY> refs not declared ...`，那批就是待加的；或 `git diff` 扫新增 `process.env.X`。
- 多个 key → 逐个走下面分类 + 落位（批量，不中途问）。

### 2. 分类（决定落哪）

对每个 key 判两个维度：

1. **secret?** —— key 名匹配 `/_KEY|_SECRET|_TOKEN|_PASSWORD|HMAC/`，或是 `.sops.yaml encrypted_regex` 里特例化的字面 key（当前：`CODE_INDEX_URL`）。匹配 → **secret**。
2. **boot-required?** —— 看它在 `<x>.config.ts` 的 zod schema：**无** `.default()`（`.parse()` 空值即抛、app/IT boot crash）→ **boot-required**；**有** `.default()` / 是测试 gate（`RUN_*` / `*_FAKE_*`）/ Expo public（`EXPO_PUBLIC_*`）→ **optional**。

### 3. 落位（自动，一次性全写，不逐个问）

#### A. 非密 key

| 位置                                          | 动作                                                                                                        | 条件                                                                                                    |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `.env.production`                             | 追加 `KEY=<prod 真值>`（feature 段头 `# === <feature> (per <x>.config.ts; <NNN>) ===`，**追加到文件末尾**） | 总是（除非纯 dev/test-only）                                                                            |
| `apps/server/.env.example`                    | 追加 `KEY=<dev 假值/空占位>`（满足 Check G：prod 非密 key ⊆ dev）                                           | 总是                                                                                                    |
| `apps/server/.env`（若存在，gitignored）      | 追加 `KEY=<本地 dev 值>`                                                                                    | 本地有 `.env` 时（保 Check A pair 对齐）                                                                |
| `docker-compose.tight.yml` app `environment:` | 加 `KEY: ${KEY:-<default>}`（discriminated union 用 `:-mock`/`:-fake` 兜底；其余 `${KEY}` 或 `${KEY:-}`）   | 总是（容器只见映射过的）                                                                                |
| `apps/server/vitest.config.ts` `test.env`     | 加 `KEY: '<test 占位>'`                                                                                     | **boot-required** 时                                                                                    |
| `check-env-sync.ts` `ALLOWLIST`               | 加 `'KEY'`                                                                                                  | **optional**（有 `.default()`/测试 gate/Expo public）→ 不进 `.env.example`，进 ALLOWLIST                |
| `check-env-sync.ts` `ENV_SPECIFIC_ALLOWLIST`  | 加 `'KEY'`                                                                                                  | 该非密 key **仅 prod 设、dev `.env.example` 不放**（prod-only，如 `MBW_VERSION` 范式）→ 否则 Check G 报 |

> 归属判定细节（必填→`.env.example` 取消注释；optional→`ALLOWLIST`）见 [`config-env-sync.md` § 归属判定](../../rules/config-env-sync.md)。

#### B. 密文 key（真值要你填）

1. 若它该加密但 key 名**不**匹配 `SECRET_KEY_RE`（像 `CODE_INDEX_URL` 这种特例）→ 先把字面 key 加进 `.sops.yaml` `encrypted_regex` **和** `check-env-sync.ts` `SECRET_KEY_RE`（两处镜像），否则 sops 不会加密它、sentinel 也不认。
2. `run_in_background` 跑：

   ```bash
   SOPS_AGE_KEY_FILE="$HOME/.config/sops/age/keys.txt" EDITOR="zed --wait" sops edit ~/.nvy/secrets.enc.env
   ```

   告诉用户：**末尾追加 `KEY=<真值>`，保存 + 关闭 zed 标签页** → sops 自动加密成 `ENC[]`。等 background 任务完成（用户关闭 zed）再继续。

3. 回调后补其余位置（密文真值**不**进 `.env.production`，Check F 会拦）：
   - `docker-compose.tight.yml` 映射 `KEY: ${KEY:-<default>}`。
   - **boot-required** → `vitest.config.ts` `test.env` 加 test 假值占位。
   - `apps/server/.env.example` 加 dev 占位（`KEY=""` 或 dev 假值；dev example 不受 Check F 约束）。
4. **若 sops edit 把值留成了明文**（已知坑：`sops edit` 用文件**内存储的**旧 `encrypted_regex` 重加密，新加的 `.sops.yaml` 特例不生效）→ check-env-sync sentinel 会报红。修：用新 regex 整体重加密——

   ```bash
   export SOPS_AGE_KEY_FILE="$HOME/.config/sops/age/keys.txt"
   sops -d ~/.nvy/secrets.enc.env \
     | sops -e --filename-override secrets.enc.env --input-type dotenv --output-type dotenv /dev/stdin \
         > /tmp/reenc.env && mv /tmp/reenc.env ~/.nvy/secrets.enc.env
   ```

### 4. 收尾 verify（必跑）

```bash
pnpm tsx scripts/checks/check-env-sync.ts        # 必绿（Check A–G）
gitleaks protect --staged --no-banner            # 密文 key 必跑：no leaks（证明真值已加密）
```

- 密文还应抽查：`grep '^KEY=' secrets.enc.env` 是 `ENC[`、`sops -d secrets.enc.env | grep '^KEY='` 是真值。
- 报告每个 key 落到了哪些位置（让用户一眼看全）。**别**自己 commit/PR——交回主流程按 git-workflow 走。

## 反模式

- ❌ 逐个 key 停下来问「这个加哪」——分类是确定的，一次性全落。
- ❌ 把密文真值写进 `.env.production` / `.env.example`（明文）——Check F / gitleaks 拦，且本就泄漏。
- ❌ 漏 compose 映射——容器读不到 = prod boot crash（2026-06-04 marketdata tick / 029 chat key 教训）。
- ❌ optional key 塞进 `.env.example`——应进 `ALLOWLIST`（默认值真相在 `.config.ts`）。
- ❌ 在 CI/headless 跑密文分支——无 zed，密文填写只能本地交互做。
