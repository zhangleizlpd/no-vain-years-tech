# Runbook — code-index 服务部署 / 运维（62）

> **前置**：本文命令块里的 `$NVY_*` 从仓外解析 —— 本机跑先 `. ~/.nvy/fleet.env`，主机上跑先 `. /etc/nvy-fleet.env`。变量清单与角色说明见 [`ops/host/fleet.env.example`](../host/fleet.env.example)；为什么真值不入库见 [`information-boundary.md`](../../docs/conventions/information-boundary.md)。
>
> `@nvy/code-index`（ideation 接地索引服务）部署到专用宿主 `index`（ssh alias 与真实绑定见 `~/.nvy/fleet.env`）的 SoT。
> 架构：[ADR-0059](../../docs/adr/0059-ideation-repo-grounding-code-index.md)（双路 + pgvector RAG）·
> [ADR-0060](../../docs/adr/0060-ideation-index-runtime-ondemand-models.md)（单机按需单模型 + vector-only）·
> [S2 plan](../../docs/private/plans/2026-06/06-22-ideation-index-s2-service.md)（部署步 8-9 = 本 runbook）。
>
> 服务是 **standalone**（`.nxignore`，workspace 外，own lockfile）。**消费者** = 云端 ideation chat（S3），经 HTTP `/search` 查询；服务**可手动停**，chat 必须优雅降级。

## 宿主拓扑（62）

> 主机定位（账号 / IP / 规格 / 角色）以 [`host-inventory.md`](./host-inventory.md) 为准；下表为 62 上 code-index 服务的部署细节。

| 项            | 值                                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| host          | `root@$NVY_INDEX_HOST`（迁移后裸 docker host，Ubuntu 24.04 / 2c / 3.4G / **no-swap→已加 4G swapfile**）                                    |
| checkout      | `/root/no-vain-years-mono`，跟踪 `main`（增量 builder git-diff 的源）                                                                      |
| service dir   | `/root/no-vain-years-mono/services/code-index`                                                                                             |
| env / secrets | `/etc/code-index.env`（chmod 600，git 树外，**不入库**）                                                                                   |
| pgvector      | docker `code-index-pgvector`，绑 `127.0.0.1:5434`，独立 volume `code-index_code-index-pgdata`                                              |
| 权重          | `<service>/.hf-cache/Xenova/bge-m3/onnx/model_quantized.onnx`（q8，~570M）                                                                 |
| 查询 API      | systemd `code-index-query.service`，:7700                                                                                                  |
| 增量          | systemd `code-index-tick.timer`（~2min）→ `code-index-tick.service`（oneshot）→ `scripts/cron-tick.sh`                                     |
| 监控          | systemd `code-index-freshness-monitor.timer`（5min）→ `scripts/check-index-freshness.sh`（drift > 30min → 飞书告警，见「增量陈旧监控」节） |

## 网络坑（CN 宿主，关键）

- **github HTTPS 被 TLS RST 掐死**（`GnuTLS recv error -110`）→ git 走 **SSH over `ssh.github.com:443`** + 只读 deploy key（`~/.ssh/config` 已配 `Host github.com → HostName ssh.github.com Port 443`）。
- **npm** 走 `registry.npmmirror.com`；**HF 权重**走 `hf-mirror.com`（`HF_ENDPOINT`，回源 CloudFront SG，快）。
- **docker hub** 拉镜像在 CN 卡死 → `/etc/docker/daemon.json` 已配 CN registry mirrors；`pgvector/pgvector:pg16` 镜像本地已存。

## 增量链路停摆的坑（2026-08-03 / 08-09 两次事故）

- 🚨 **`git HEAD` 不是索引进度，`index_meta.last_sha` 才是**（08-09 事故，已修）。cron-tick 曾用「HEAD == origin/main」判断还有没有活干；可 fast-forward 与 embed 是两件事，builder 在 ff 之后死掉，两者就永久劈叉：HEAD 说追平、DB 差 2 个 commit，而 tick 只听前者 → 每 2min 成功 exit 0、零工作、105 次（3.5h），直到 main 再来一个 commit 才偶然解冻。**这也让 `TimeoutStartSec` 那层兜底完全空转 —— 超时确实 SIGTERM 了、timer 确实重排了，重排出来的 tick 却从这个判据 exit 0。** 现改为无条件 exec builder，由 builder 自己比 `last_sha` vs HEAD（相等则在加载模型前返回，无 RAM 代价）。⚠️ 别为了「省一次 tsx 启动」把这个判断加回 shell 里。
- **io_uring 会让干完活的 builder 不退出**。62 的 `/usr/bin/node` 是 Ubuntu 包，链的是**系统 libuv 1.48**（`node -p process.versions.uv`，不是 node 18 自带的 1.44），在 kernel 6.8 上其 io_uring 路径会丢 fs 完成事件 → loop 里挂着永不完成的 request → 进程打完 `✓ incremental done`（`last_sha` 已落库）却停在 `ep_poll` 不退。识别特征：`ps` 见 `iou-sqp-*` 线程、CPU 不涨、RSS ~1G、`/proc/<pid>/fdinfo/<io_uring fd>` 里 Sq/Cq 全排空。**修法**：unit 里 `Environment=UV_USE_IO_URING=0`（tick + query 两个 unit 都已带）。
- **`Type=oneshot` 默认没有启动超时**（`TimeoutStartSec=infinity`）。一次挂死就把 unit 永久钉在 `activating`，而 `OnUnitActiveSec=` 的 timer 要等本次激活结束才排下一次 → `systemctl is-active` 报 **active、`Trigger: n/a`**，`list-timers` 的 NEXT 是 `-`，从此一次不跑（该次事故 17h 零增量）。**修法**：`TimeoutStartSec=4h` 兜底（超时 → SIGTERM → unit failed → timer 立即排下一次，重做该批）。⚠️ **超时必须宽于最大合法批次**：初版取 90min，而全仓 sweep 型 PR 一次 ~1400 chunk、按该机 0.2–0.5 chunk/s 就要 ~90min（08-09 那批差几十秒没跑完被砍）。**一个真实批次够得到的超时比没有超时更糟** —— 它把一次慢 tick 变成永不收敛的 kill-retry 循环。
- **诊断口诀**（先分清两种形态，它们的表征恰好相反）：
  - tick **卡在 `activating`** → builder 挂死。看 `systemctl status code-index-tick.service` 和 `list-timers` 的 NEXT 是不是 `-`。freshness 监控 §5 已把这条并进告警文案。
  - tick **每次成功 exit 0 却零工作** → 上面第一条那个判据病。直接对比 `git rev-parse HEAD` 与 `index_meta.last_sha`，**两个 SHA 劈叉即确诊**；再查「正文有、向量无」的残留：`select count(*) from chunk c left join emb_bgem3 e on e.chunk_id=c.id where e.chunk_id is null`。
- **手工恢复**（只要活已干完、`last_sha` 已推进，直接停掉挂死的 unit 即可，timer 会立刻重排）：`systemctl stop code-index-tick.service`。

## A. 宿主准备（一次性）

1. **swapfile 4G**（ADR-0060 §5 **刚需**，no-swap 撞车 = OOM 硬杀）：

   ```bash
   fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
   echo '/swapfile none swap sw 0 0' >> /etc/fstab
   sysctl -w vm.swappiness=10 && echo 'vm.swappiness=10' >> /etc/sysctl.conf   # 偏好 RAM，swap 作 OOM 安全网
   ```

   verify：`swapon --show` 见 4G。

2. **只读 deploy key**（git fetch 用）：62 上 `ssh-keygen -t ed25519 -f ~/.ssh/code_index_deploy -N ''`，把 `.pub` 加为 GitHub 仓库 **read-only Deploy Key**，`~/.ssh/config` 走 `ssh.github.com:443`，remote 改 SSH。verify：`ssh -T git@github.com` 见 `successfully authenticated`。
3. **checkout**：`/root/no-vain-years-mono` 跟踪 `main`，`git config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'`。
4. **node + pnpm**：系统 node 18；`npm i -g pnpm@9`（npmmirror registry）。
5. **deps**（service dir）—— **关键 flag**：

   ```bash
   ONNXRUNTIME_NODE_INSTALL_CUDA=skip pnpm install --ignore-workspace
   ```

   > ⚠️ onnxruntime-node 在 **linux-x64 默认自动下 CUDA EP**（~200M 走 GitHub Fastly CDN），CN 龟速形同断流，且纯 CPU 机用不上。CPU runtime 已打包进 tarball，**`=skip` 跳过即可**（不加这个 flag，install 会卡在 `node ./script/install` 拉 `libonnxruntime_providers_cuda.so`）。

6. **权重**：首次 embed 自动从 hf-mirror 下到 `.hf-cache`（~570M）。可预热：跑一次任意 embed。

## B. pgvector + secrets

1. **secrets** → `/etc/code-index.env`（chmod 600）：强随机 `CODE_INDEX_SERVICE_TOKEN`（`openssl rand -hex 32`，**fail-closed**：未设服务拒启）+ 非默认 `CODE_INDEX_PG_PASSWORD`（`openssl rand -hex 24`）+ 其余 config（见 service `README.md` Env 表 / `src/config.ts`）。完整 key：`CODE_INDEX_REPO_MONO_ROOT` `CODE_INDEX_BRANCH=main` `CODE_INDEX_PG_*` `CODE_INDEX_HF_CACHE` `HF_ENDPOINT` `CODE_INDEX_PORT=7700` `CODE_INDEX_DTYPE=q8` `CODE_INDEX_HEARTBEAT` 等。
2. **起 pgvector**：

   ```bash
   docker compose --env-file /etc/code-index.env -f /root/no-vain-years-mono/services/code-index/docker-compose.yml up -d
   ```

   verify：`docker inspect -f '{{.State.Health.Status}}' code-index-pgvector` = healthy。

   > 鉴权验证陷阱：`docker exec psql -U codeindex`（无 `-h`）走 Unix socket = pg_hba `trust`，**不校验密码**。要测密码必须走**非回环源 IP**（scram-sha-256）：`docker run --rm --network code-index_default -e PGPASSWORD=<x> pgvector/pgvector:pg16 psql -h code-index-pgvector -U codeindex -d codeindex -c 'select 1'`。

## C. 冷建 off-box → 灌 62（ADR-0060：62 不跑冷建）

> 62 吞吐 0.2–0.5 chunk/s，全量冷建 5–9h；故冷建走快机（Mac ~12min/5842 chunk），dump 灌 62。62 此后**只跑增量**。

1. **快机**（service dir，HEAD == 62 追踪的 commit）：起本地 pgvector（compose 默认即可，throwaway）→ `pnpm index:full mono`（~12min；首跑下权重）。verify：`✓ full build done: N chunks · vectors N`。
2. dump + scp：

   ```bash
   docker exec code-index-pgvector pg_dump -U codeindex -Fc codeindex > /tmp/codeindex.fc
   scp /tmp/codeindex.fc "root@$NVY_INDEX_HOST":/tmp/
   ```

3. **62** 灌入 B 起的 pgvector（已建 `vector` 扩展、无表）：

   ```bash
   docker exec -i code-index-pgvector pg_restore -U codeindex -d codeindex --no-owner --no-acl < /tmp/codeindex.fc
   ```

4. verify：62 的 `chunk`/`emb_bgem3` 计数 == 快机；**`index_meta.last_sha` == 62 checkout 的 HEAD**（否则首次增量 diff 范围错）；HNSW `emb_bgem3_vec_idx` 存在。
5. 拆快机 throwaway 栈：`docker compose -f .../docker-compose.yml down -v`。

## D. 服务化（systemd）

unit 模板在 `services/code-index/deploy/`。安装：

```bash
cp /root/no-vain-years-mono/services/code-index/deploy/code-index-query.service /etc/systemd/system/
cp /root/no-vain-years-mono/services/code-index/deploy/code-index-tick.{service,timer} /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now code-index-query.service
systemctl enable --now code-index-tick.timer
docker update --restart unless-stopped code-index-pgvector   # 旧容器补 reboot-survival（新建会从 compose 带上）
```

verify：

```bash
systemctl is-active code-index-query                       # active
curl -fsS localhost:7700/healthz                           # {"ok":true}
set -a; . /etc/code-index.env; set +a
curl -fsS -H "Authorization: Bearer $CODE_INDEX_SERVICE_TOKEN" \
  -X POST localhost:7700/search -d '{"repo":"mono","query":"登录 use case"}'   # 命中 results
systemctl list-timers code-index-tick.timer                # 下次触发时间
```

mutex（≤1 bge-m3）：查询会话活跃（heartbeat 新鲜）时 `code-index-tick.service` 应 skip（journal 见 `query session active — skipping`）。

## 增量陈旧监控（freshness 告警）

> 增量链路有静默 stall 风险：cron-tick **无新 commit 不 re-embed、照样 exit 0**，所以「`indexed_at` 太老」不能当告警信号（安静期它本来就老但健康）。真正该逮的是 **drift 持续**——`origin/main` 前进但 `index_meta.last_sha` 在窗口内没跟上。`check-index-freshness.sh` 探**真·远端 tip（`git ls-remote`）vs 库内 `last_sha`**，drift > 窗口（默认 30min）→ 飞书告警。统一逮住所有静默模式：query 心跳长期占用（每 tick skip）/ builder 崩溃循环 / `git fetch` 认证失败 / timer 被禁用。

设计要点：

1. **drift-with-grace**：用 state 文件（`/var/lib/code-index/freshness.state`）记 pending SHA 首次出现时间，超窗口才报，窗口内算「正在追」不报。
2. **抑噪**：query 心跳新鲜（< TTL，与 cron-tick 同逻辑）时 index 滞后是 ADR-0060 设计内的「query 让位」，不误报。
3. **timer 存活直检**：`code-index-tick.timer` 未 active → 直接告警（安静期也能提前逮死 timer）。
4. **ls-remote 连通性重试**：`git ls-remote` 探活对 CN host → `ssh.github.com:443` 的瞬时 RST/超时**短退避重试**（`INDEX_LS_REMOTE_TRIES` 默认 3 次，退避 3s/6s），单次网络抖动不再误报；真·持续断网 / deploy key 失效仍会全失败 → 照常告警。
5. **告警复用同一飞书 bot**：所有运维推送统一走共享 `ops/lib/feishu-send.sh`，公共 webhook/secret 在 `/etc/nvy-alert.env`（`NVY_ALERT_*`，全机同一套变量）。bot 校验用**签名校验**（`NVY_ALERT_FEISHU_SECRET`），不再依赖「自定义关键词」（旧「告警」关键词约束已放开 —— 见 [scheduled-tasks.md](./scheduled-tasks.md)）。本监控**仅 drift > 窗口才推**，且同一问题按 `INDEX_ALERT_REPEAT_MIN`（默认 60min）**去重**：签名把数字归一化（「已 275m」与「已 280m」算同一条），而问题类别一变（`ls-remote` 失败 → drift 停滞）签名立刻变、新问题第一时间推得出去。⚠️ 去重只压**推送**，检测与 exit 1 不受影响，`systemctl --failed` / journal 始终是全貌。08-09 之前这里**只有 grace、没有去重**（本节旧文案却写着「保留 grace/去重」），一次 19h 的停滞推了约 220 条 —— **刷屏和没有告警是同一种失效**。正向 liveness 走每日摘要 `code-index-daily-digest`（每日 09:10）。

安装（unit 模板在 `services/code-index/deploy/`）：

```bash
cp /root/no-vain-years-mono/services/code-index/deploy/code-index-freshness-monitor.{service,timer} /etc/systemd/system/
cp /root/no-vain-years-mono/services/code-index/deploy/code-index-daily-digest.{service,timer} /etc/systemd/system/
# 公共飞书配置（全机共享，所有定时任务复用；签名校验下 secret 必填；缺 → 仅日志不推）：
printf 'NVY_ALERT_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/XXXX\nNVY_ALERT_FEISHU_SECRET=YYYY\n' | sudo tee /etc/nvy-alert.env
# 可选覆盖窗口（任务调参，与公共配置分离）：echo 'INDEX_STALE_WINDOW_MIN=30' | sudo tee /etc/code-index-monitor.env
systemctl daemon-reload && systemctl enable --now code-index-freshness-monitor.timer code-index-daily-digest.timer
```

verify：

```bash
systemctl list-timers 'code-index-*.timer'                  # 下次触发时间（freshness + digest）
systemctl start code-index-freshness-monitor.service        # 立即跑一次
journalctl -u code-index-freshness-monitor -n 20            # 见 ✅ 已追平 / report
systemctl start code-index-daily-digest.service             # 验每日摘要 → 群里见 ✅ 摘要（24h 提交数）
# 强制触发一次真推送（窗口设 0 → 任何 drift 立报）；手动跑须自带飞书配置（systemd 由 EnvironmentFile 注入）：
sudo bash -c 'set -a; . /etc/nvy-alert.env; set +a; INDEX_STALE_WINDOW_MIN=0 /usr/bin/bash /root/no-vain-years-mono/services/code-index/scripts/check-index-freshness.sh'
```

未配 webhook 时仅日志 + 退非零（`systemctl --failed` 可见），与证书监控同构（graceful pre-config）。

## 运维

| 操作                  | 命令                                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| 查询日志              | `journalctl -u code-index-query -f`                                                                         |
| 增量日志              | `journalctl -u code-index-tick -n 50`                                                                       |
| 手动触发增量          | `systemctl start code-index-tick.service`                                                                   |
| 监控日志 / 手动跑     | `journalctl -u code-index-freshness-monitor -n 20` / `systemctl start code-index-freshness-monitor.service` |
| 停服务（chat 须降级） | `systemctl stop code-index-query.service code-index-tick.timer`                                             |
| 重启                  | `systemctl restart code-index-query.service`                                                                |
| 看常驻模型            | 平时 0；会话/索引时 1 份 bge-m3（ADR-0060）                                                                 |

## 增量引擎并发 / rebase（设计说明）

- **≤1 builder（ADR-0060 ≤1 模型）**：systemd `Type=oneshot` 单实例已串行化 timer 触发的构建；额外地，builder 持**真排他锁**（`lock.ts` `acquireBuilderLock`，O_EXCL + pid 存活检查），任何第二个 builder 拿不到锁会立即退出、不加载模型。⚠️ **勿在 timer 运行期手动跑** `tsx src/index-incremental.ts` / `index:full`——锁会让它直接退出（安全），但别指望它能并行加速。崩溃残留的 stale 锁会被下个 builder 自动回收。
- **rebase / force-push 恢复**：mono 平时 squash 合并 = 线性 main，cron-tick 走 `merge --ff-only`。若 `origin/main` 被改写（force-push），ff 失败 → cron-tick **自动 `git reset --hard origin/<branch>`**（checkout 是只读镜像、无本地 commit，安全）恢复，不再每 tick 静默 abort。增量随后 `diff lastSha..HEAD`（baseline 仍是合法 tree）。极端情况 baseline 被 git gc（默认 ~2 周）清掉则 `diff` 报错 → 重跑一次 `index:full` 重灌即可。

## Rollback / teardown

- 停服务：`systemctl disable --now code-index-query.service code-index-tick.timer`。
- 重灌索引：重跑 C（drop+restore；或 `docker compose down -v` 清 volume 后重灌）。
- 全拆：上面 + `docker compose -f .../docker-compose.yml down -v` + 删 `/etc/code-index.env` `/etc/code-index-monitor.env`（`/etc/nvy-alert.env` 若本机仅 code-index 用则一并删）+ 删 `/etc/systemd/system/code-index-*`（含 freshness-monitor + daily-digest）。

## phase E — 网络暴露 ✅ 已上线（2026-06-25 live 实证）

- 查询 API 绑 `0.0.0.0:7700`（安全组拦公网，**保持拦**）。S3 的 ideation server 在 **77** 跨主机打 62 `/search`+`/repos` → **WireGuard 隧道 62↔77 已上线**（隧道活跃 + 77 app `CODE_INDEX_PROVIDER=http`/`CODE_INDEX_URL=http://10.88.0.1:7700` + 端到端 `/healthz` 通），77 经隧道虚 IP `10.88.0.1:7700` 访问、token 隧道内加密承载。完整 bring-up + 77 env 接线 + smoke + rollback + token 轮换：**→ [`code-index-tunnel.md`](./code-index-tunnel.md)**。
