# marketdata-dev-sync — 本地 dev 投资域测试数据每日同步

每天早上从 **prod**(`nvy-tight-postgres-1` / db `mbw`)抽样同步「投资域测试数据」到 **本地 dev PG**(`mbw-poc-postgres:5433` / db `mbw_poc`),供 marketdata / quote / alert / portfolio 本地联调。

> ⚠️ **仅本地联调用**。会把 prod 真实数据子集搬到本机 dev 库。

## 数据形态(精简但自洽)

| 表                                                                                     | 搬运范围                                                   |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `instrument`                                                                           | **全量**(~5,600,任何股可搜/选)                             |
| `daily_bar`                                                                            | 全股**最近 20 个交易日** + ~15 支**样本股全历史**(~729 天) |
| `adjustment_factor` / `corporate_action` / `fundamental_snapshot` / `financial_metric` | **仅随样本股**                                             |
| 美股期权面(`option_contract` / `earnings_event` / IV / 指数 / `optionsdesk.anchor*`)   | **全量**(体量小,045-048 期权台本地要真数据)                |
| `option_daily_snapshot`                                                                | **最近 30 个自然日**(≈21 个交易日;按 `session_date` 切)    |

`option_daily_snapshot` 是仓内唯一**无上限增长**的表(实测约 580 行/标的/交易日,随锚数线性涨;12 个锚时约 7,000 行/交易日 ⇒ 全量一年约 176 万行),而本工具是「截断 → 重灌」全量语义 ⇒ 只能走近窗。取 30 天是两头夹的结果:消费端功能下界 = **2 个 session**(腿表只读最近一期;采集覆盖率闸要基线日 + 当日),体量上界 ≈ 14.7 万行(与 `daily_bar` 同量级)。要重算:`行/年 ≈ 锚数 × 580 × 252`。

结论:**样本股全功能**(指标 / 复权 / K 线 / EOD 预警,需 ≥520 根历史);**非样本股仅近端价**(quote / 搜索 / 列表)。样本股清单见 `sync.sh` 顶部 `SAMPLE_CODES`。

## 为什么这么切

prod 唯一重表是 `daily_bar`(3.94M 行);其余表全 < 3.5 万行。全股搬全历史没必要,故只有样本股留全历史、其余股留近窗。每次**全量截断重灌**(事务原子,失败回滚保旧数据)——12 万行量级不值得上增量水位。

## 无密钥

- **prod 侧**:免密 SSH `"$NVY_APP_SSH"`（代号 `app`，真值在 `~/.nvy/fleet.env`） → 容器内 `docker exec -i psql`(unix socket trust),纯 `COPY (...) TO STDOUT`(只读 SELECT,无 prod 写)。
- **本地侧**:`mbw:mbw@localhost:5433/mbw_poc`(非密钥,已在 `apps/server/.env.example`)。

## 用法

```bash
# 前置(首次):本地 dev schema 已迁移
cd apps/server && pnpm prisma migrate deploy && cd -

# 手动同步一次
pnpm dev-marketdata:sync

# 安装每日定时(默认 09:00;仅 macOS launchd)
pnpm dev-marketdata:setup            # 或 --time 09:00
# 手动触发定时任务验证
launchctl kickstart -k gui/$(id -u)/com.nvy.marketdata-dev-sync

# 卸载
pnpm dev-marketdata:uninstall
```

可经 env 覆盖:

| env                                 | 默认   | 含义                                                                   |
| ----------------------------------- | ------ | ---------------------------------------------------------------------- |
| `RECENT_DAYS`                       | 20     | `daily_bar` 近窗,单位**交易日**                                        |
| `OPTION_RECENT_DAYS`                | 30     | `option_daily_snapshot` 近窗,单位**自然日**(刻意与上一条分开,量纲不同) |
| `ROW_WARN_THRESHOLD`                | 300000 | 单表导出行数超此值 → **告警不中断**(趋势预警)                          |
| `DEPLOY_STALE_DAYS`                 | 14     | 部署副本天龄超此值且读不到仓内源 → 告警(见「部署漂移」)                |
| `PROD_SSH` / `PROD_CTR` / `LOCAL_*` | —      | 连接目标                                                               |

## 部署漂移(为什么改完 `sync.sh` 必须重跑 setup)

定时任务跑的是 `~/.nvy` 下的**冻结副本**,改仓内源不重跑 `setup.sh` ⇒ 09:05 跑的仍是旧版,而**失败形态是「静默的成功」**:日志照常打 `✅ 同步完成`、退出码 0,只是少同步了几张表(2026-08-11 实撞,存在两天没人发现)。

`sync.sh` 起手做一次自检,**只告警不中断**(旧逻辑通常还能跑出部分数据,硬失败反而更糟):

| 从哪跑                                                        | 比什么                                                   | 命中时                                                              |
| ------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------- |
| 仓内(手动 `pnpm dev-marketdata:sync`)                         | 自己 ↔ `~/.nvy` 副本                                     | ⚠️「定时任务跑的仍是旧版」——改完手动验一次就命中                    |
| `~/.nvy`(launchd)                                             | 自己 ↔ `deployed.meta` 印记;**再试着**读印记里记的仓内源 | ⚠️「副本落后于仓内」                                                |
| 同上,但读不到仓内源(launchd 对 `~/Documents` 无 TCC,**常态**) | 退化成部署天龄                                           | 每轮汇总打「commit + 部署于 N 天前」;N ≥ `DEPLOY_STALE_DAYS` 才告警 |

印记 `~/.nvy/marketdata-dev-sync/deployed.meta` 由 `setup.sh` 写(源文件 sha256 + commit + 部署时刻)。

## 与持仓同步的关系

两个独立的本地晨间 launchd 任务,错开几分钟:

| 时间(CST) | 任务                                                   | 方向               |
| --------- | ------------------------------------------------------ | ------------------ |
| 09:00     | `com.nvy.marketdata-dev-sync`(本工具)                  | prod → 本地 dev PG |
| 09:05     | `com.nvy.holdings-sync`(`scripts/jobs/holdings-sync/`) | 同花顺 → prod      |

数据侧任意早上时间都安全:prod 的理杏仁同步 22:00 起跑、当晚 ~22:30 前就位。约束只是 **Mac 须在该时刻醒着**(setup 会打印 `pmset` 唤醒命令)。

## 文件

| 文件           | 作用                                                                    |
| -------------- | ----------------------------------------------------------------------- |
| `sync.sh`      | 同步 payload(漂移自检 → 导出 → 截断重灌 → 序列重置 → 通知)              |
| `setup.sh`     | 生成 wrapper + plist + 部署印记并 `launchctl bootstrap`(`--time HH:MM`) |
| `sync.test.sh` | `sync.sh` 里纯函数的对照表测试(不连 prod / 不碰 DB;PR 门内跑)           |
| `uninstall.sh` | `bootout` + 删 plist(不删数据)                                          |

运行态(机外,不入库):`~/.nvy/marketdata-dev-sync/`(`run-scheduled.sh` / `deployed.meta` 部署印记 / `sync.log` 结果 / `launchd.log` 原始输出)。

## 已知限制

- **Mac 睡眠不触发**:用 setup 打印的 `sudo pmset repeat wakeorpoweron ...` 唤醒。
- **非样本股仅近 20 日、无复权因子**:其 forward/backward K 线在近窗内若恰遇除权会微偏(`/quote` 用 none 不受影响)。
- **免密 SSH**:依赖 `~/.ssh` key 非交互(带 passphrase 需进 keychain)。
- **周末/节假日仍跑**:prod 无新数据,重灌同数据,无害(几秒 SSH COPY)。
- **期权链只有近 30 天**:本地验不了跨月的历史链回看(消费端目前也只取最近 1-2 个 session)。要更长:`OPTION_RECENT_DAYS=90 pnpm dev-marketdata:sync`。
- **漂移检测在 launchd 那一臂是「代理量」**:读不到仓内源时只能靠部署天龄,它只说明「很久没重新部署」,不等于仓内确实变了;真正的正面命中靠仓内手动跑那一臂。
