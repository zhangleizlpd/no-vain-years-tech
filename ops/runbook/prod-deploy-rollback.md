# Prod Deploy & Rollback Runbook

> **前置**：本文命令块里的 `$NVY_*` 从仓外解析 —— 本机跑先 `. ~/.nvy/fleet.env`，主机上跑先 `. /etc/nvy-fleet.env`。变量清单与角色说明见 [`ops/host/fleet.env.example`](../host/fleet.env.example)；为什么真值不入库见 [`information-boundary.md`](../../docs/conventions/information-boundary.md)。
>
> 生产部署 = ACR 镜像 + 单机 ECS docker compose（per [ADR-0026](../../docs/adr/0026-backend-deployment-topology.md)）。本文记录**带 config 校验闸 + 自动/手动回滚**的部署流程。活的真相在 `.github/workflows/deploy.yml` 与 `ops/bin/rollback-prod.sh`。

## 部署流程（`deploy.yml`，SSH 进 ECS 跑）

1. **`git reset --hard origin/main`（默认，全 git 驱动）** 拉全套编排——`docker-compose.tight.yml` / `.env.production`（已 tracked，per PR #571）/ nginx 一次性原子同步。**密文不在其中**（2026-08-08 起不入库，常驻主机 `/etc/nvy/secrets.enc.env`，见 [`secrets-sops.md`](secrets-sops.md) §3.3）。host `origin` 走 SSH-over-`ssh.github.com:443`（见下「§ 77 SSH-to-GitHub」）+ 3×5s 重试。首次 git 驱动会把 77 上**未 tracked** 的旧 `.env.production` 备份成 `.env.production.bak-pre-track-*` 再让 reset 接管。仅 `skip_git_fetch=true`（纯镜像 hotfix + GFW 抖）才跳过 reset，直接用磁盘上现有的 compose/.env.production；密文不受该开关影响。
2. `export MBW_VERSION=<tag>`（**不** `sed .env.production`）——compose 读 shell env 优先于 `--env-file`，tag 即生效且 tracked 文件保持 pristine（无 working-tree drift，下次 reset 干净）。
3. `docker login` ACR → `docker compose pull app`。
4. **Pre-deploy config 闸（B2）**：`docker compose run --rm --no-deps --entrypoint node app dist/config/validate-config.js` —— 用**新镜像自己**的 Zod validator 校验**容器真实 env**（compose `run` 会拼出 `DATABASE_URL`/`REDIS_URL` + 应用 `:-default`）。任一 config 非法 → 打印缺失/非法 key 全清单 → `exit 2`，**不 recreate**（活容器不动）。
5. `docker compose up -d --force-recreate app`。
6. 等 120s healthcheck（`/healthz/live`）。
   - **healthy** → 公网 smoke（`https://api.shintongtech.com/healthz/live`）→ 把本次 tag 写入 `.last-good-tag`（回滚基线）。
   - **不 healthy** → 抓最后 80 行日志 → **自动回滚**到 `.last-good-tag`（调 `rollback-prod.sh`）恢复在线 → `exit 1`（部署标记失败、通知你）。

### 步 2 的 `<tag>` 从哪来

`build-image` 把**它自己解析出的镜像 tag**（已 strip `server-` 前缀）写成 `image-tag` artifact；`deploy` 经 `workflow_run.id` 取回。**不从触发方的 ref 名推断** —— 那个老判据隐含「build-image 恒由 tag push 触发」，一旦走 dispatch，`head_branch` 是分支名（如 `main`），deploy 会去 pull 一个不存在的 `...:main`（issue #53，2026-08-14 实撞）。artifact 取不到时**硬失败**并打印补救命令，**不回落**。

手动 `workflow_dispatch` 触发 `deploy.yml` 时走 `inputs.tag`，与上面无关。

### hotfix：重建某个已有 tag 的镜像

发版流程自身出问题（如 #52：buildx attestation 被 ACR 拒收）导致某 tag 的镜像没构出来时，**从 `main` dispatch `build-image.yml`，`tag` 填那个 git tag**：

- workflow 文件恒来自 dispatch 所选的 ref ⇒ 选 `main` 才拿得到**已修好**的 workflow（选那个旧 tag 会把坏 workflow 再跑一遍）；
- `checkout` 的 `ref:` 认 `inputs.tag` ⇒ 构建的**代码树是那个 tag 的**，镜像内容与它的标签一致。

两者刻意分离，缺一不可。⚠️ `tag` 必须是**真实存在的 git ref**，不能是凭空标签；分支名含 `/`（本仓 `fix/xxx` 规范）不能用 —— docker tag 不允许 `/`，会在 push 时红。

> 「容器只读到 compose `environment:` 块里显式映射的变量」+「新配置项的 9 连 boot-path」见 [`.claude/rules/config-env-sync.md`](../../.claude/rules/config-env-sync.md)。**新增 config key 时**：非密真值进 committed `.env.production`（随全 git 驱动 deploy 自动到 prod）；secret 进**仓外**密文（`sops edit ~/.nvy/secrets.enc.env`）并**手动 scp** 到 prod `/etc/nvy/`（§3.3）—— 这一步不自动，漏了会被 B2 闸拦下。

**密钥值**的注入：deploy + rollback 已接 `sops exec-env`（守卫式，prod 没 sops/`secrets.enc.env` 时 fallback 明文老路）—— 私钥纳管 / cutover / 新增密钥流程见 [`secrets-sops.md`](secrets-sops.md)（cutover 未执行前仍是明文 `.env.production` 老路）。

## 非-app 服务（postgres / redis / nginx）的 compose 改动不随 deploy 生效

步 5 只 `up -d --force-recreate **app**` —— **postgres / redis / nginx 容器部署时完全不动**（步 1 `git reset --hard` 会把改过的 compose 拉到 host，但 compose 只 recreate 被点名的 `app`）。所以改了这三个服务的 compose 段（`ports` / `command` / `environment:` 映射 / image pin）后，**deploy 跑完也不生效**，须在 77 上手动重建对应服务：

```bash
cd /home/admin/no-vain-years-mono
git pull --ff-only origin main          # 或等下次 deploy 的 reset --hard 带过来
export SOPS_AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-$HOME/.config/sops/age/keys.txt}"
sops exec-env secrets.enc.env "docker compose -f docker-compose.tight.yml --env-file .env.production up -d postgres"
```

⚠️ **必须 `sops exec-env` 包裹**（prod 已 SOPS cutover，`DB_PASSWORD` / `REDIS_PASSWORD` 只在 `secrets.enc.env`）—— 漏包裹则 `${DB_PASSWORD}` 以空串重建（现有 named volume 下 PG 口令不变、无数据损坏，但容器 env 脏）。重建 postgres / redis 会让 app 瞬断该依赖几秒（Prisma / bullmq 自动重连），**低峰期做**。

**admin 连 prod PG（TablePlus 等）**：PG 已发布 host loopback `127.0.0.1:5432`（仅本机可达、非公网；rationale 见 `docker-compose.tight.yml` postgres `ports` 内联注释，PR #684）。SSH 隧道（`"$NVY_APP_SSH"`，真值见 `~/.nvy/fleet.env`）→ DB Host 填 `127.0.0.1` / User `mbw` / DB `mbw` / 密码 = `DB_PASSWORD`（scram：`127.0.0.1/32 trust` 只对容器内 loopback 生效，隧道来自 docker 网关命中 `host all all all scram-sha-256`）。此前隧道指容器内网 IP（`172.18.0.x`），整栈重启 Docker 重排 → 连接静默失效，故改用固定 loopback。

## 回滚

### 自动（无需你操作）

新部署 healthcheck 失败 → `deploy.yml` 自动回到 `.last-good-tag`（上一次验证健康的版本），prod 不中断。首次部署（还没 `.last-good-tag`）跳过自动回滚。

### 手动（发布当时健康、事后发现有问题）

SSH 进 ECS，在 `/home/admin/no-vain-years-mono` 下：

```bash
# 回到上一个验证健康的版本
ops/bin/rollback-prod.sh

# 或回到你指定的某个旧 ACR tag（vX.Y.Z 不可变 tag 都在 ACR）
ops/bin/rollback-prod.sh v0.3.1
```

机制 = 反向部署：`export MBW_VERSION=<回滚 tag>`（不改 tracked `.env.production`）→ `up -d --force-recreate app` → 等 healthcheck + smoke → 写 `.last-good-tag`。旧镜像通常本地有缓存（秒级）；若被 prune 则需先 `docker login` ACR 再跑（脚本会自动 pull）。

> ⚠️ **image-only 回滚的硬前提**：被回滚的发布必须用向后兼容的 expand-migrate-contract migration（[`.claude/rules/migration-rules.md` § 2](../../.claude/rules/migration-rules.md)）。破坏性 forward migration 回滚后旧代码会撞上更新的 schema —— 那种发布不能靠本脚本回滚。

## 77 SSH-to-GitHub（规避 HTTPS GnuTLS 不稳，镜像 62 code-index）

77（live prod）直连 `github.com` HTTPS 有间歇 GnuTLS RST（分钟级窗口），曾迫使 `skip_git_fetch=true` 默认 + 密钥手动 scp。改走 **SSH over `ssh.github.com:443`** + 只读 deploy key（与 62 code-index 同法，见 [`code-index-deploy.md`](code-index-deploy.md) §网络坑）后，`git fetch` 稳定 → `deploy.yml` 已切**默认 `skip_git_fetch=false` 全 git 驱动**（每次部署 `git reset --hard origin/main` 拉全编排，含 `.env.production`；密文已出仓，见「部署流程」步 1）。

**一次性 host 设置**（`admin@77`，checkout = `/home/admin/no-vain-years-mono`；72 是 `root`，77 是 `admin`，路径/key 落 `/home/admin/.ssh/`）：

```bash
# 1. 只读 deploy key（git fetch 用，非 push）
ssh-keygen -t ed25519 -f ~/.ssh/prod_github_deploy -N ''

# 2. ~/.ssh/config 走 ssh.github.com:443 + 指定该 key
cat >> ~/.ssh/config <<'EOF'
Host github.com
    HostName ssh.github.com
    Port 443
    IdentityFile ~/.ssh/prod_github_deploy
    IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config

# 3. .pub 注册为 repo read-only Deploy Key（在有 gh 的机器上，凭 .pub 内容）：
#    gh repo deploy-key add ~/.ssh/prod_github_deploy.pub --title "77-prod-readonly" -R zhangleizlpd/no-vain-years
#    （读写均可省，本 key 只读 fetch；与 62 的 code_index_deploy 是不同 key，同仓允许多 deploy key）

# 4. checkout remote 改 SSH
cd /home/admin/no-vain-years-mono
git remote set-url origin git@github.com:zhangleizlpd/no-vain-years.git

# 5. 验证
ssh -T git@github.com           # → "Hi zhangleizlpd/no-vain-years! You've successfully authenticated..."
git fetch origin main           # 应秒回、无 3×5s 重试
```

> ⚠️ **deploy key 唯一性**：同一 SSH key 不能同时作多个 repo 的 deploy key，但**同一 repo 可挂多个 deploy key** —— 77 用独立新 key，与 62 `code_index_deploy` 并存于本仓 Deploy Keys，互不冲突。
> ⚠️ 此设置**与 `APP_SSH_KEY` 无关**：`APP_SSH_KEY`（GitHub secret）是 **GH runner → SSH 进 77** 的钥匙；本节是 **77 → SSH 拉 GitHub** 的钥匙，两条独立链路。
> 设置前 `deploy.yml` 的 secrets 拉取仍可工作（HTTPS，flaky，失败回退磁盘副本）；设置后才稳。故 `deploy.yml` 改动可先合、host 设置后补。

## 首次启用注意

- `.last-good-tag` / `.env.production.bak-*` 是 prod 本机运行态文件，gitignored，不入库。
- 接入后**第一次**部署成功才会生成 `.last-good-tag`；在那之前自动回滚是 no-op。
- 上线后建议**低峰期手动跑一次 `rollback-prod.sh <上个 tag>`** 真验证回滚链路（再回到 latest），确认 work 再依赖自动回滚。
- `APP_SSH_KEY` secret 必须**保留尾换行**，否则 `webfactory/ssh-agent` 报 `error in libcrypto`；用 `gh secret set APP_SSH_KEY < keyfile` 设置（勿手动粘贴丢换行）。

### ✅ 首次 git-driven 部署 + 回滚演练已验证（2026-06-24，v0.13.1）

全 git 驱动这条路**已在 live 77 实跑验通一遍**，下列环节均有实测背书（无需再首跑验证，除非重新 cutover）：

- **部署全路径**：`git reset --hard origin/main`（首次把 77 上 **untracked** 旧 `.env.production` 备份成 `.env.production.bak-pre-track-*` 再接管，之后 tracked → 稳态无 drift）→ `🔐 SOPS` 注入 → **B2 config 闸过** → **真 `force-recreate`**（实测 `Recreate→Started`，非 `docker compose run` 吞 stdin 的假成功 no-op，per § B2 内联告警）→ healthcheck healthy（t+20s）→ 公网 smoke `{"status":"ok"}` → 写 `.last-good-tag`。容器内实测新增配置（compose 映射的 `ASR_PROVIDER` + SOPS 注的 `DASHSCOPE_API_KEY`）确已到位。
- **回滚链路双向验通**：`rollback-prod.sh v0.12.0` → healthy → roll forward `rollback-prod.sh v0.13.1` → healthy（各 t+20s + 公网 smoke）。与**自动回滚同脚本**，故自动回滚链路一并背书。
- ⚠️ **踩坑留痕：release tag 存在 ≠ ACR 镜像已构建**。首次部 `v0.13.0` 失败,因其 `build-image` run **早已红**（035 ASR phantom dep `ws` → `tsc` TS2307,镜像没推 ACR）,deploy 止于 `docker compose pull app`（`...:v0.13.0: not found`）。但 **pull 在 `up --force-recreate` 之前 + `set -e`,活容器（旧 tag）完全未被触碰** —— 这本身验证了 pull-before-recreate 的保护。⇒ 部某 tag 前先确认其 `build-image` 绿（`gh run list --workflow=build-image.yml`）;见 image `not found` 先查 build-image 是否红,别误判 deploy 机制。
