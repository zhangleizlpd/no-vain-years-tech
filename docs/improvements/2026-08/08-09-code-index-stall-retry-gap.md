# 接地检索又停 19h —— 这次是「重试通道本身不存在」（62 / code-index）

> 2026-08-09 事故记录。上一次（[08-03](08-03-code-index-tick-hang-selfheal.md)）装的兜底自愈在本次**一次都没生效**——因为它的重试会被 tick 的触发判据吃掉。
> 运维 SoT = [`ops/runbook/code-index-deploy.md`](../../../ops/runbook/code-index-deploy.md)（耐久结论已回写该 runbook「宿主 runtime 坑」节）。

## 1. 现象

服务面全绿：`/healthz` 200、`code-index-query` active、pgvector healthy、`code-index-tick.timer` active、tick 每 2min **成功退出（exit 0，4 秒）**。

而检索语料停在 `594a1f72`，昨日两个 PR 的改动一个字都没进索引。查「标识符边界 代号 主机」不命中新增的 `docs/conventions/information-boundary.md`，反而漂到 `optionsdesk/anchor.rules.ts` 的「四区间边界」。

DB 侧：**98 个文件 / 1426 个 chunk 有正文、零向量**（`chunk` 9372 vs `emb_bgem3` 7946）。98 恰等于 builder 日志里的 `corpus delta: 98 changed`。

## 2. 时间线（journal 直接观测）

| 时刻（CST）         | 事件                                                                | 读数                                                |
| ------------------- | ------------------------------------------------------------------- | --------------------------------------------------- |
| 08-08 09:09         | 最后一次成功增量                                                    | `last_sha=594a1f72`；09:10 digest 报「✅ 已追平」   |
| 08-08 09:23 → 23:09 | 每次 tick `ERROR: Repository not found.` / `status=128`，**13h46m** | 仓库迁新账号，宿主 deploy key 对新仓不可见          |
| 08-08 23:09         | fetch 恢复 → ff 到 `1364d105` → spawn builder                       | `→ incremental: 594a1f72..1364d105 / 98 changed`    |
| 08-09 00:39:16      | builder 撞 `TimeoutStartSec=90min` → SIGTERM                        | `status=143`，`Consumed 1h30min49s CPU / 1.8G peak` |
| 08-09 00:39 → 04:08 | **105 次 tick，每次 4 秒、exit 0、零工作**                          | `last_sha` 纹丝不动                                 |

## 3. 根因分解（三层，独立成因）

### 3.1 重试通道不存在（本次停摆的直接原因，自己的设计缺口）

`cron-tick.sh` 用**「checkout 的 HEAD 是否等于 origin/main」**判断还有没有活干：

```bash
LOCAL=$(git rev-parse HEAD)          # 23:09 那次 ff 已经把它推到 1364d105
REMOTE=$(git rev-parse origin/main)
if [ "$LOCAL" = "$REMOTE" ]; then exit 0; fi
```

但**进度状态是 `index_meta.last_sha`（在 pgvector 里），不是 checkout 的 HEAD**。fast-forward 与 embed 是两件事，builder 一旦在 ff 之后死掉，两者就永久劈叉：HEAD 说「追平了」，DB 说「差 2 个 commit」，而 tick 只听前者。

⇒ **08-03 装的 `TimeoutStartSec` 兜底在本次完全空转。** 那次的 unit 注释写着「timer 立即排下一次 tick —— the link self-heals」；timer 确实立刻重排了，可重排出来的 tick 从上面那行 `exit 0` 走掉。**自愈机制存在、被触发、然后被一个更早的判据吞掉** —— 这比没有自愈更危险，因为它让人以为这条路已经护住了。

唯一的解冻条件是 main 再出现新 commit（那会让 `LOCAL != REMOTE` 再次成立）。当晚收工后无新 commit，于是卡到被人工发现。

### 3.2 超时窗口窄于最大合法批次（让 3.1 有机会发作）

1426 chunk ÷ 该机实测 0.2–0.5 chunk/s ≈ **91min**，而超时是 90min —— 这批活本身就骑在超时线上。

🟢 **止血重跑把这条从推算变成了实测**：同一批 diff、同一台机、脱掉超时跑，`04:08:07 → 05:39:03` = **90min 56s**（`Consumed 1h 31min 19.800s CPU`）。**比 90min 的超时只多 56 秒。** 08-09 那次不是「差得远」，是差了不到一分钟——而代价是 98 个文件整整 5 小时零向量。

08-03 定 90min 时的推算是「正常批次 22 chunk ≈ 75s，最坏可想象批次（数百 chunk）也在 30min 内」。低估在于：全仓 sweep 型 PR（标识符脱敏、大规模重命名）一次就能改上百文件、上千 chunk，这不是「不可想象」，是每隔几周就有一次。

**一个真实批次能够到的超时，比没有超时更糟**：它把一次慢 tick 变成永不收敛的 kill-retry 循环（若 3.1 已修）。

### 3.3 攒批落库：中断即全损（放大 3.2 的后果）

`indexFiles` 原先是「全部 embed 完 → 再逐条写向量」：

```ts
const vecs = await embedSequential(
  e,
  records.map((r) => r.embedInput),
  onProgress,
);
for (let i = 0; i < records.length; i++) await upsertEmb(records[i].id, vecs[i]);
```

向量在被 SIGTERM 时还躺在内存数组里 ⇒ 98 个文件全部只剩正文、零向量、**在向量检索里彻底隐身**。若边 embed 边落库，同样这一刀只丢 1 条，已跑完的部分立即可检索。

### 3.4 前置诱因（已恢复，与本次修复正交）

09:23–23:09 宿主对 `origin` 的每次 fetch 都返回 `ERROR: Repository not found.`（git exit 128），13h46m 零索引，23:09 起恢复正常。窗口正好落在 GitHub 账号迁移当天，最可能是迁移期间旧仓地址不可达；**具体是哪一步、以及 23:09 由什么动作恢复的，journal 只留了客户端侧的 128，没有取证到**，不作断言。

宿主当前的 remote 与 deploy key **都指向在用的那个仓、验证通过**（`ssh -T git@github.com` 应答的就是它），没有需要清理的残留。

记在这里不是因为它是根因——**即使 fetch 从未断过，3.1 的缺口一样会在任何一次 builder 中途死亡后发作**——而是因为它解释了那批 diff 为什么会攒到 98 个文件：13h46m 没进过索引。它同时是第 4 节的一半：那段时间监控**每 5min 都在报** `ls-remote 失败`，一共 166 条，没有一条被处理。

## 4. 观测面的失效：告警刷屏 = 告警缺失

monitor 每 5min 跑一次，故障是持续态，而脚本**只有 grace 窗口、没有去重** ⇒ 从 08-08 09:24 到发现为止推了 **约 220 条**飞书告警（前 166 条 `ls-remote 失败`，后 57 条 `增量停滞`）。

runbook 当时的描述写的是「保留 grace/去重，不刷屏」——**「去重」那半句在代码里从来不存在**。文档描述了一个没实现的性质，且没有任何东西会让这个偏差自己暴露出来。

## 5. 修复

| 层                      | 改动                                                                                       | 作用                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| **重试通道**（3.1）     | `cron-tick.sh` 去掉 `HEAD == origin/main` 的 early-exit，无条件 exec builder               | 判据收归**一处**：builder 比 `last_sha` vs HEAD，相等则在加载模型前返回       |
| **超时窗口**（3.2）     | tick unit `TimeoutStartSec` 90min → **4h**                                                 | 覆盖 ~4000 chunk（吞吐带低端）；再大就该重灌全量，而不是继续加超时            |
| **落库粒度**（3.3）     | `embedSequential` 加 `onStore` 回调，`indexFiles` 边 embed 边 `upsertEmb`                  | 中断只丢 1 条；已完成的文件立刻可检索                                         |
| **告警去重**（第 4 节） | `check-index-freshness.sh` 加签名去重（数字归一化 + `INDEX_ALERT_REPEAT_MIN`，默认 60min） | 同一问题 60min 内只推一次；问题**类别**一变立刻重新推。检测与 exit 1 不受影响 |
| **stuck 阈值**          | `INDEX_TICK_STUCK_MIN` 45 → **150**min                                                     | 必须宽于最大合法批次，否则正常全仓 sweep 被判成挂死                           |

无条件 exec builder 的代价：每 2min 多一次 tsx 启动（~2-3s）。换来的是 journal 里每次 tick 都有应用层输出——**以前 tick 静默 exit 0 时，journal 里只有 systemd 的 Starting/Finished，看不出它到底干没干活**。

## 6. 验证

- **止血**（脱离 systemd 超时：`systemd-run --unit=code-index-catchup --property=TimeoutStartSec=infinity --setenv=UV_USE_IO_URING=0`）：`✓ incremental done: +1426 chunks · stored 9372 · vectors 9372`；`last_sha` = `1364d105`（追平 origin/main）；**孤儿 chunk 归零**（9372 chunk / 9372 vector）。
- **检索面验收**（不看 DB 看用户可感知面）：故障时查「标识符边界 代号 主机」漂到 `optionsdesk/anchor.rules.ts` 的「四区间边界」；恢复后首条命中 `docs/conventions/information-boundary.md` 的 `## 代号纪律` 段（score 0.659）。
- **监控自证**：`code-index-freshness-monitor` 立即跑一次 → `remote=1364d105 last_sha=1364d105` / `✅ 已追平` / `✅ 接地检索增量正常`，exit 0（故障期它连续 4.75h 报 exit 1）。
- **流式落库**：4 条新单测锁住「embed 与落库交替（攒批实现会给出 `embed,embed,store,store`）」「中途抛错时先前条目已落库」「向量与输入顺序对齐」「进度按已落库计数」。
- **去重签名三臂**：`275m` vs `280m` → 同签名（抑制）；停滞 vs `ls-remote` 失败 → 异签名（立刻推）；换 pending SHA → 异签名（立刻推）。
- **shell 语法**：两个脚本 `bash -n` 通过。

## 7. 复发怎么认（30 秒诊断）

告警说落后、而 tick **成功退出**（不是卡 activating，与 08-03 的形态相反）时：

```bash
# 1. 两个 SHA 分开看 —— 它们劈叉就是本次这个病
git -C /root/no-vain-years-mono rev-parse HEAD          # checkout 走到哪
docker exec code-index-pgvector psql -U codeindex -d codeindex \
  -tAc "select last_sha from index_meta where repo='mono'"   # 实际 embed 到哪

# 2. 有没有「正文有、向量无」的残留（上一次被杀留下的）
docker exec code-index-pgvector psql -U codeindex -d codeindex -tAc \
  "select count(*) from chunk c left join emb_bgem3 e on e.chunk_id=c.id where e.chunk_id is null"
```

> 📌 **可迁移的通则**：自愈机制的验证必须走**完整回路**，不能只验它被触发。08-03 验到了「timer 立即重排下一次 tick」就收工——那是回路的前半段；后半段「重排出来的 tick 真的会重做那批活」从未被验，而缺口正好在那里。**问「重试真的会重做吗」，别停在「重试真的会发生吗」。**
