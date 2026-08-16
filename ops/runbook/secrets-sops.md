# Prod Secrets — SOPS + age Runbook

> 把 prod **密钥的值**从「部署后人肉 SSH 改 `.env.production`」收口为「本机 `sops` 改一次、
> 带外推到 prod」（propagation 见 §3.3）。
>
> 🔁 **2026-08-08 反转：密文不再入库。** 仓转公开后，「密文一旦公开就永久公开」是不可撤销的
> —— 将来 age 私钥一旦泄漏，历史上每一版密文都能被回溯解密，而那时已无从收回。所以密文改走
> **带外**：canonical 在 dev 机 `~/.nvy/secrets.enc.env`，prod 常驻 `/etc/nvy/secrets.enc.env`。
> key **名**仍留仓内（那是对账契约，且本来就是明文），出仓的只有密文本体 —— 这也保住了
> 原设计的另一半：**CI 无需私钥就能查出漏 key**。
> 落地设计与决策门见 spike
> [`docs/private/plans/2026-06/06-15-sops-age-secrets-adoption-spike.md`](../../docs/private/plans/2026-06/06-15-sops-age-secrets-adoption-spike.md)。
> 部署/回滚主流程仍见 [`prod-deploy-rollback.md`](prod-deploy-rollback.md)；本文只管「密钥怎么进 prod」。

## 1. 文件与密钥布局

| 物件                          | 位置                                                           | git                     | 说明                                                                                                                                       |
| ----------------------------- | -------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `secrets.enc.env`             | dev `~/.nvy/` + prod `/etc/nvy/`（**不在 repo**）              | **untracked（密文）**   | SOPS dotenv：key 名明文、value `ENC[...]`。prod 侧 `640 root:admin` —— deploy 以 `admin` 跑，root-only 会让 `sops exec-env` 直接权限拒绝   |
| `.sops.yaml`                  | repo 根                                                        | tracked                 | creation rule：`encrypted_regex` + age **公钥** recipient                                                                                  |
| age **私钥**                  | dev `~/.config/sops/age/keys.txt` + prod 同路径 + **离线备份** | **永不进 git/CI 日志**  | 解密用；带外分发；权限 `600`                                                                                                               |
| `.env.production`（非密钥行） | repo 根                                                        | **tracked**（per #571） | prod 非密 config（`MARKETDATA_PROVIDER` / `CORS_*` / `*_GATEWAY` / `DB_USERNAME` / `MBW_VERSION` 等）；deploy `git reset --hard` 拉到 prod |

当前 age 公钥（recipient，明文可公开）：

```text
age12zyxzvrn6e7zlyqv68dzr77xkvwjednurr7prs7mmqza4sn0vdkszlh46a
```

加密的 key 集 = `.sops.yaml` `encrypted_regex` 匹配的 key 名（当前 = 名含
`_KEY|_SECRET|_TOKEN|_PASSWORD|HMAC` 的后缀者，**加** `.sops.yaml` 里字面特例化的 key——
当前 `CODE_INDEX_URL`，WireGuard 隧道端点与其 token 同作一个 SOPS 单元）。**别在此硬编
枚举/计数**——会随 feature 漂；`.sops.yaml` 是 SoT，实时清单（不解密，CI 同款）：

```bash
grep -oE '^[A-Z_]+=' ~/.nvy/secrets.enc.env | tr -d '='
```

## 2. age 私钥 bootstrap + 备份（SPOF —— 最重要）

私钥 = **单点故障**：丢 = 全密钥不可解；泄 = 全盘沦陷。**必须三处备份**：

1. dev：`~/.config/sops/age/keys.txt`（`age-keygen -o` 生成，`chmod 600`）
2. prod：scp 到同路径，`chmod 600`（deploy/rollback 解密时读）
3. **离线**：`cat ~/.config/sops/age/keys.txt` → 密码管理器 / 离线介质

> ⚠️ **macOS 坑**：Go `os.UserConfigDir()` 在 macOS 返回 `~/Library/Application Support`，
> **不是** `~/.config`，所以 dev 上 sops 不会自动找到 `~/.config/sops/age/keys.txt`。
> 必须显式 `export SOPS_AGE_KEY_FILE="$HOME/.config/sops/age/keys.txt"`（或把 key 放进
> `~/Library/Application Support/sops/age/`）。prod（Linux）`~/.config` 能自动找到，但
> deploy.yml / rollback-prod.sh 仍显式设 `SOPS_AGE_KEY_FILE` 求稳。

装工具（dev + prod；国内走 GitHub release 二进制，必要时挂代理）：

```bash
brew install sops age          # dev (macOS)
# prod (ubuntu 24.04 x86_64)：从 github.com/getsops/sops releases 下 linux amd64 二进制
```

## 3. 日常操作

cutover 后改密钥**只在 dev 改一次**（不再 SSH 上 prod 改 `.env.production`）。`EDITOR` 需带
wait flag（本仓 dev = `zed --wait`；vim 默认即可）—— sops 等编辑器**关闭**后才重新加密。

```bash
export SOPS_AGE_KEY_FILE="$HOME/.config/sops/age/keys.txt"   # macOS 必须

sops edit ~/.nvy/secrets.enc.env   # 打开解密后的明文;存盘 + 关闭编辑器 → 自动加密回写

# 查 key 名（不解密）
grep -oE '^[A-Z_]+=' ~/.nvy/secrets.enc.env | tr -d '='
# 确认某 key 非空（不打印值）
sops exec-env ~/.nvy/secrets.enc.env 'sh -c "echo ${#DEEPSEEK_API_KEY}"'
# 看某 key 真值（解密到 stdout，慎用，会打印明文）
sops -d ~/.nvy/secrets.enc.env | grep '^DEEPSEEK_API_KEY='
```

### 3.1 改一个已有 key 的真值（最常见，如填真 `sk-...`）

1. `export SOPS_AGE_KEY_FILE=...` → `sops edit ~/.nvy/secrets.enc.env` 改值 → 存盘关编辑器。
   ⚠️ 不再有 `git diff` 可看（密文已出仓）→ verify 改用 `sops -d ~/.nvy/secrets.enc.env | grep <KEY>`；
   `pnpm tsx scripts/checks/check-env-sync.ts` 绿
2. **propagation 到 prod** —— 见 §3.3（**不自动**，且现在**没有** git 这条路）

### 3.2 加一个全新 key

> 完整 boot-path（哪些 key 算 secret、9+1 位置、CI Check A–F）见 path-rule
> [`.claude/rules/config-env-sync.md`](../../.claude/rules/config-env-sync.md)（触 env/config/`secrets.enc.env`/`.sops.yaml` 自动加载）。本节只管 secret 在 SOPS 里的增改。

1. `sops edit ~/.nvy/secrets.enc.env` 加 `NEW_API_KEY=...`
2. `docker-compose.tight.yml` app `environment:` 映射 `NEW_API_KEY: ${NEW_API_KEY}`
   - 若 boot-required（app 启动 `.parse()` 必须）→ 进 `apps/server/vitest.config.ts` test.env
     → verify：`check-env-sync` 绿（Check D 映射 + Check E 在 `secrets.enc.env`）
3. 仓内改动（compose 映射 / vitest test.env）commit → PR → 合入；**密文本体不在这条链上**，
   单独走 §3.3 推 prod
4. 🚨 **问一句：这个键在宿主上有没有「派生消费者」？** —— `secrets.enc.env` 不只被 app 直接读，
   宿主上还有**从它派生出来的别的文件**，而派生那一步**没有任何自动化**：密钥进了 SOPS
   **不等于**进了那些文件，两侧的失败时机还完全错开（app 一切正常、另一侧部署红在别处）。

   消费者清单与「直接读 vs 派生」的区别见 [`deploy-topology.md`](deploy-topology.md) § 2；
   判据不要背清单，按需扫：`rg -l 'secrets.enc.env' ops/ services/`。

### 3.3 让新值到 prod（带外 scp —— git 这条路已不存在）

**2026-08-08 起**：密文不入库，所以 `git reset --hard` **不再**把它带到 prod。`deploy.yml`
读的是主机上的 `/etc/nvy/secrets.enc.env`，且**读不到就硬失败**（不再回落明文 —— 回落只会
让 app 带着缺失配置起来，要么被 B2 闸拦下多烧一轮，要么某个 secret 恰好有 zod 默认值而
**静默降级上线**）。

改完密钥后推到 prod：

```bash
# dev 机（密文 canonical 在 ~/.nvy/）
. ~/.nvy/fleet.env
scp ~/.nvy/secrets.enc.env "$NVY_APP_SSH":/tmp/s.enc.env
ssh "$NVY_APP_SSH" 'sudo install -D -m 640 -o root -g admin /tmp/s.enc.env /etc/nvy/secrets.enc.env && rm -f /tmp/s.enc.env'

# verify：以 deploy 的真实身份（admin，非 root）确认可读可解
ssh "$NVY_APP_SSH" 'sops -d /etc/nvy/secrets.enc.env | grep -c "^[A-Z_]*="'
```

🚨 **权限必须是 `640 root:admin`，不能是 `600 root:root`。** deploy 以 `admin` 跑，root-only
会让 `sops exec-env` 报 permission denied —— 而这个错**只在真部署时才出现**，本地用 `sudo`
测会假阳性通过（2026-08-08 实测踩中：先用 sudo 验「通过」，换成 admin 身份才暴露）。
`admin` 已持有 age 私钥（`~/.config/sops/age/keys.txt`，`600 admin:admin`），所以让它读密文
零边际风险；给 group 只读不给写，是为了让被攻陷的 admin 不能篡改密文。

推完后让新值生效：下一次 deploy 自动带上；想立刻生效就跑一次回滚脚本重建容器：

```bash
ssh "$NVY_APP_SSH" 'cd "$NVY_APP_REPO_DIR" && ops/bin/rollback-prod.sh <当前 tag>'
```

## 4. deploy / rollback 注入机制

`deploy.yml` 与 `rollback-prod.sh` 都从**主机上**读密文，且 **fail-closed**：

```bash
NVY_SECRETS_ENC="${NVY_SECRETS_ENC:-/etc/nvy/secrets.enc.env}"
command -v sops >/dev/null || { echo "sops 未装"; exit 1; }
[ -f "$NVY_SECRETS_ENC" ] || { echo "密文缺失：$NVY_SECRETS_ENC"; exit 1; }   # 并打印恢复命令
sops exec-env "$NVY_SECRETS_ENC" "docker compose ... up -d --force-recreate app"
```

- `sops exec-env` 把解密后的密钥注入 child env，compose `${VAR}` 插值读 shell env（**优先于
  `--env-file`**），**无明文落盘**。
- 🔁 **2026-08-08：取消了「回落明文 `.env.production`」那条旧 fallback。** 它当年是为 cutover
  过渡期存在的（prod 还没 sops/私钥时不破坏既有部署），cutover 早已完成，而现在
  `.env.production` 里**一个 secret 都没有** —— 回落只会让 app 带着缺失配置起来：要么被 B2 闸
  拦下（多烧一次 pull + 一轮容器），要么更糟，某个 secret 恰好有 zod 默认值于是**静默降级上线**。
  一条只能通向坏结局的 fallback，比硬失败差。
- B2 config 闸同样包在 `with_secrets` 里——校验「合并后」真实 env。

## 5. prod cutover（step → verify；**破坏性，最后做**）

> 📌 **历史记录（cutover 已完成）**：本节是 SOPS cutover 一次性过程的留痕。下方「禁 `skip=false`」
> 是 cutover 当时的约束（本地 drift 未和解）；现 drift 已和解 + SSH-443 稳，default 已切
> `skip=false` 全 git 驱动（见 §3.3）。本节不回改，仅作冻结记录。
>
> 前置：age 私钥已三处备份（§2）+ `secrets.enc.env` 已合入 main。

⚠️ **prod checkout 钉 #145 + 承重本地 drift**（`docker-compose.tight.yml` / nginx 本地改动未进 main）。
因此 **禁** `skip_git_fetch=false`（`git reset --hard origin/main` 会 clobber 这些 drift）。
`secrets.enc.env` / 新 `rollback-prod.sh` 一律**单文件 scp** 上 prod（同 #356 模式）；deploy 走默认
`skip_git_fetch=true`（不 reset）。`deploy.yml` 本身在 GH runner 跑（取 main），不需上 prod。

1. prod 装 sops + 私钥就位（`~/.config/sops/age/keys.txt` `600`）+ **scp** `secrets.enc.env` 与新
   `rollback-prod.sh` 到 prod repo → verify：`SOPS_AGE_KEY_FILE=~/.config/sops/age/keys.txt sops -d secrets.enc.env >/dev/null` 在 prod 成功
2. PR 合入 main（新 `deploy.yml` 生效）后，`workflow_dispatch` deploy **当前 tag**，
   `skip_git_fetch=true`（默认，不 reset）→ 新 `deploy.yml` 检测 prod 上 sops+`secrets.enc.env` →
   走 SOPS 路径 recreate（**此时明文仍在 `.env.production`，安全网**）→ verify：deploy 绿，日志见 `🔐 prod secrets via SOPS` + 健康
3. 健康确认后，删 prod `.env.production` 里的**明文密钥行**（§1 的 13 个；非密钥行保留）→
   `cp .env.production .env.production.bak-pre-sops-$(date +%s)` 先备份
4. 再 recreate 一次（密钥此时**只**来自 SOPS）仍健康 → verify：
   `ops/bin/rollback-prod.sh v<current>` 跑通 + 公网 smoke 绿

回滚本 cutover：`.env.production` 明文行先别删；出问题把 prod sops/secrets.enc.env 移走即回
fallback 老路。明文行验证 §5.4 通过后才删。

## 6. 轮换 / 应急

- **轮换某密钥值**：见 §3.1（`sops edit` 改值 → commit/PR）+ §3.3（scp 到 prod）。
- **轮换 age 密钥对**（私钥疑似泄露）：`age-keygen` 新对 → `.sops.yaml` 换公钥 →
  `sops updatekeys secrets.enc.env` 重新封装 → 新私钥铺 dev/prod/离线 → 旧私钥作废。
- **私钥丢失**（三处全丢）：`secrets.enc.env` 不可解 —— 从各 vendor 控制台/密码管理器重置
  全部 13 个密钥，重建 `secrets.enc.env`。这就是为什么**离线备份必须有**。

## 7. CI 防护

- `scripts/checks/check-env-sync.ts` **Check E**：每个 boot-required 密钥必须 ∈ `secrets.enc.env`
  key 集（grep，不解密）——「忘了把密钥加进 SOPS」变 CI 红。
- 同脚本 **sentinel**：`secrets.enc.env` 里敏感 key 的 value 必须 `ENC[...]`——防误提交明文。
- `gitleaks`（ci.yml）二层兜底扫明文密钥。
