---
paths:
  - '**/.env'
  - '**/.env.example'
  - '.env.production'
  - 'apps/server/src/config/**'
  - '**/docker-compose*.yml'
  - 'apps/server/vitest.config.ts'
  - 'scripts/ci/server-boot-smoke.ts'
  - 'apps/mobile/e2e/_support/real-backend-harness.ts'
  - 'secrets.enc.env'
  - '.sops.yaml'
---

# 配置项 / env var 同步纪律（path-triggered）

> 触及任一 env / server config / compose / 测试 boot 文件自动加载。**加一个 server 配置项不是改一行——是一条 boot-path**。
>
> 🤖 **新增 config 项就调 [`/config-add`](../skills/config-add/SKILL.md) skill** —— 它按本文规则一次性把 key 落到所有位置（非密自动写明文位置；密文开 zed/sops 让你填真值），收尾跑 `check-env-sync`。本文是规则 SoT，skill 是其可执行版。

## `.env.example` 是什么（别误解）

运行时**谁都不加载它**。它只有两个职责：① `cp .env.example .env` onboarding 模板；② 权威 key 清单，`scripts/checks/check-env-sync.ts` 拿它 diff。本地 `nx serve` 读 `apps/server/.env`（真值，gitignored）；**测试不读 `.env` 也不读 `.env.example`**，IT/e2e boot 吃 `vitest.config.ts` `test.env` + harness 里写死的占位。

## 加一个 server env var → 9 个位置（缺一即埋雷）

| #   | 位置                                                                                                   | 护栏                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `apps/server/src/config/<x>.config.ts`（zod + `process.env.X`）                                        | — 出生地                                                                                                                                                                              |
| 2   | `apps/server/.env.example`                                                                             | `check-env-sync`（**仅当 commit 动了 trigger 文件才跑**）                                                                                                                             |
| 3   | `apps/server/.env`（本地真值）                                                                         | 同上（pair diff，key 必须与 example 完全一致）                                                                                                                                        |
| 4   | `apps/server/vitest.config.ts` `test.env` 占位                                                         | ✅ 硬门：缺则 server IT boot crash → pr-validation 红                                                                                                                                 |
| 5   | `scripts/ci/server-boot-smoke.ts` 占位                                                                 | ⚠️ 未接 CI，手动脚本                                                                                                                                                                  |
| 6   | `apps/mobile/e2e/_support/real-backend-harness.ts` 占位                                                | 🟡 仅 nightly `e2e-real-backend`（软信号）                                                                                                                                            |
| 7   | `.env.production`（**committed**，非密真值，deploy `--env-file` 读）                                   | ✅ Check C（boot-required 非密 ∈ 此或 #8）+ Check F（明文 secret 拦）+ Check G（非密 key ⊆ dev `.env.example`）                                                                       |
| 8   | `secrets.enc.env`（**仓外密文**：dev `~/.nvy/` + prod `/etc/nvy/`，secret 真值，`sops exec-env` 注入） | ✅ Check E（boot-required secret 必在此）+ sentinel（值必 `ENC[]`）；填值走 `sops edit ~/.nvy/secrets.enc.env`                                                                        |
| 9   | `docker-compose.tight.yml` app `environment:` `KEY: ${KEY}`                                            | ✅ Check D——**容器只读映射过的变量；漏映射=读不到=prod boot crash**（2026-06-04 marketdata tick + 029 chat key 都栽在这）+ Check H 反方向兜底（#7/#8 声明过的键 compose 零引用 = 红） |

> 旧 #8「prod 服务器上手填 `.env.production`」已**作废**——`.env.production` 进 git 后 deploy 全 git 驱动拉取（部署机制见 [`prod-deploy-rollback.md`](../../ops/runbook/prod-deploy-rollback.md)），不再 SSH 上服务器人肉填非密值。

dev compose（`docker-compose.dev.yml`）只起 PG+Redis，**不起 app** → 不用加映射，只有 `.tight.yml`（prod）要加。

> 🚨 **`${VAR:-}` 空串陷阱（P-0 #799 实证）**：compose 的 `${VAR:-}` 映射在变量缺失时给容器喂**空串而非 undefined**；zod 字段若 `.optional()` 且带 `.min(1)` / `.url()` 类非空约束，会被空串炸红（P-0 当时差点把「生产恰好因漏映射而能跑」修成 boot crash）。映射这类字段前先在 config factory 里折叠空串（`blankAsAbsent` 范式，先例 `sms.config.ts` / `agent-bridge.config.ts`）。此判定需读 zod schema，机器难静态强制 → review 把关。

## 各配置文件职责（真值落哪）

| 文件                                               | git                         | 职责                                                                                                                                   | secret 怎么放                                             |
| -------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `apps/server/.env.example`                         | committed                   | dev onboarding 模板 + key 清单（Check A/G diff 源）；`cp → .env`                                                                       | dev-only 假值 / 空占位（**非真值**，Check F 豁免 dev）    |
| `apps/server/.env`                                 | gitignored                  | 本地 dev 真值                                                                                                                          | 本地 dev 值（真 / mock）                                  |
| `.env.production`                                  | **committed**               | **prod 非密真值**（公开）；deploy `--env-file` 读                                                                                      | **不放**（secret 全在 SOPS；Check F 扫它拦明文 secret）   |
| `secrets.enc.env`                                  | **untracked（密文，仓外）** | **所有 prod secret 真值**（age 加密 `ENC[]`）；`sops exec-env` 运行时注入。dev `~/.nvy/` 是 canonical，prod `/etc/nvy/` 640 root:admin | ✅ 真值（`sops edit ~/.nvy/secrets.enc.env`）             |
| `apps/server/vitest.config.ts` `test.env`          | committed                   | boot-required secret 占位（测试 boot 注册表）                                                                                          | 测试假值占位                                              |
| `docker-compose.tight.yml`                         | committed                   | 容器 env 映射 `KEY: ${KEY}`（容器只见映射过的）                                                                                        | 映射 `${SECRET}`（值来自 sops 注入的 shell env）          |
| `apps/mobile/e2e/_support/real-backend-harness.ts` | committed                   | contract-smoke 的 fake/placeholder env                                                                                                 | placeholder（`CHAT_FAKE_LLM=1` / `ASR_PROVIDER=fake` 等） |

## 🔑 第一步先判 secret vs 非-secret（决定真值落哪）

**在动上面 9 位置之前先问：这个 key 是 secret 吗？** 名含 `_KEY` / `_SECRET` / `_TOKEN` / `_PASSWORD` / `HMAC`（= `.sops.yaml` `encrypted_regex`，`check-env-sync` 的 `SECRET_KEY_RE`；外加特例 `CODE_INDEX_URL`——WireGuard 隧道端点与其 token 同作一个 SOPS 单元）→ **是 secret**：

- **真值 → `secrets.enc.env`**（位置 #8，**仓外**），经 `sops edit ~/.nvy/secrets.enc.env`（加密成 `ENC[...]`）。🚨 **禁**把真值写进明文 `.env.production`（CI Check F sentinel 拦：tracked 明文 `.env.production` 里 secret-命名 key 带值 = 红；gitleaks 是第二层）。取代「secret 真值进服务器手填 `.env.production`」的旧做法。
- dev `#2 .env.example` 仍放 **空占位 `KEY=""` 或 dev-only 假值**（本地 boot 用，**非**真值；dev example 不受 sentinel 约束）。
- 仍要 `#9` compose 映射；boot-required 的还要 `#4` vitest test.env 占位（`check-env-sync` Check E 强制 boot-required secret ∈ `secrets.enc.env`）。
- propagation 到 prod：🔁 **2026-08-08 起密文不随 git**（仓已公开 —— 密文一旦公开就永久公开，将来私钥一泄漏即全量回溯解密）。改走**带外 scp** 到 prod `/etc/nvy/`，见 [`secrets-sops.md`](../../ops/runbook/secrets-sops.md) §3.3。key **名**仍在仓内，那是 Check C/E/H 的对账契约。

否则（名不含上述后缀）→ **非 secret config**：照上面位置走明文 `.env.production`（committed），并满足 Check G（同名非密 key dev `.env.example` 也要有）。SOT = [`ops/runbook/secrets-sops.md`](../../ops/runbook/secrets-sops.md)。

## 归属判定（决定落 example 还是 ALLOWLIST）

1. **必填 / 条件必填（zod 无 `.default()`）** → `.env.example` 取消注释 + 本地 `.env`（mock-safe 空值亦可）。
2. **可选（zod 有 `.default()`）/ 测试 gate（`RUN_*`/`CHAT_FAKE_LLM`）/ Expo public（`EXPO_PUBLIC_*`）** → `scripts/checks/check-env-sync.ts` 的 `ALLOWLIST`，默认值真相留在 `.config.ts`，不进 example。

## env 文件维护体例（`.env.example` / `.env.production`）

- **段落分隔**：每个 feature 一段 `# === <feature> (per <x>.config.ts; <NNN>) ===` 头，段间空行隔开。
- **结尾追加**：新增 key / 段一律**追加到文件末尾**（按 feature 编号递增，最新在底部）—— diff 干净、新增永远在底部好找；**不插进文件中部**。

## CI 强制 vs 人肉清单

- **强制**（`check-env-sync`）：#2↔#3 key 对齐；`process.env.X` 全声明；boot-required key（= `vitest.config.ts test.env` 占位集，被 #4 硬门强制）∈ `.env.production` **或** `secrets.enc.env`（Check C）且已映射进 compose（Check D）；boot-required **secret** ∈ `secrets.enc.env`（Check E）；tracked 明文 `.env.production` 里**任何** secret-命名 key 带值 = 红（Check F sentinel，覆盖非-boot-required secret）；`.env.production` 非密 key ⊆ dev `.env.example`（Check G，除 `ENV_SPECIFIC_ALLOWLIST` 的 prod-only key 如 `MBW_VERSION` / `DB_USERNAME` / `MARKETDATA_TICK_ENABLED`）；**声明在 `.env.production` / `secrets.enc.env` 的任何键必须被 compose 引用**（映射行或 `${KEY}` 插值均算；零引用 = 容器看不见的死配置 = 静默 fallback 事故类，Check H；蓄意 host-only 的键进 `HOST_ONLY_PROD_KEYS` 并注明消费方）。
- **人肉**：#5 smoke 占位、prod-only-required（如 live 时的 `LIXINGER_TOKEN`，mock 默认故不在 test.env，真值经 `sops edit secrets.enc.env` 填）——这些 CI 不拦，部署 chat / 启用 feature 时照本表逐条过。

## 覆盖范围（G-7 判定，2026-08-03）

本纪律与 `check-env-sync` 只管 **server app**（55 键全过 zod）。三个例外均为**明示接受**，不是缺口：

1. `services/code-index` / `services/futu-shim`：独立部署（62 机 / 港机）、各自 runbook 管，**蓄意不纳入**——不在 server boot path，配置错在各自主机上响亮失败，纳入本 check 反而制造跨服务假耦合。
2. `IP2REGION_XDB_PATH`：optional 路径覆盖 + 内建三候选 `existsSync` 兜底 + 已登记 `.env.example`——裸读 `process.env` 但行为完备，加 zod 零收益。

单源真理：`scripts/checks/check-env-sync.ts`（算法 A–H + ALLOWLIST / ENV_SPECIFIC_ALLOWLIST / HOST_ONLY_PROD_KEYS 体例）；secret 加密 / propagation 见 [`ops/runbook/secrets-sops.md`](../../ops/runbook/secrets-sops.md)；compose 映射判定见 `docker-compose.tight.yml` 内联注释。
