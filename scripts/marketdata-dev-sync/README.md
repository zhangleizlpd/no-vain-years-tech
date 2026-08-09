# marketdata-dev-sync — 本地 dev 投资域测试数据每日同步

每天早上从 **prod**(`nvy-tight-postgres-1` / db `mbw`)抽样同步「投资域测试数据」到 **本地 dev PG**(`mbw-poc-postgres:5433` / db `mbw_poc`),供 marketdata / quote / alert / portfolio 本地联调。

> ⚠️ **仅本地联调用**。会把 prod 真实数据子集搬到本机 dev 库。

## 数据形态(精简但自洽)

| 表                                                                                     | 搬运范围                                                   |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `instrument`                                                                           | **全量**(~5,600,任何股可搜/选)                             |
| `daily_bar`                                                                            | 全股**最近 20 个交易日** + ~15 支**样本股全历史**(~729 天) |
| `adjustment_factor` / `corporate_action` / `fundamental_snapshot` / `financial_metric` | **仅随样本股**                                             |

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

可经 env 覆盖:`RECENT_DAYS`(默认 20)、`PROD_SSH` / `PROD_CTR`、`LOCAL_*`。

## 与持仓同步的关系

两个独立的本地晨间 launchd 任务,错开几分钟:

| 时间(CST) | 任务                                              | 方向               |
| --------- | ------------------------------------------------- | ------------------ |
| 09:00     | `com.nvy.marketdata-dev-sync`(本工具)             | prod → 本地 dev PG |
| 09:05     | `com.nvy.holdings-sync`(`scripts/holdings-sync/`) | 同花顺 → prod      |

数据侧任意早上时间都安全:prod 的理杏仁同步 22:00 起跑、当晚 ~22:30 前就位。约束只是 **Mac 须在该时刻醒着**(setup 会打印 `pmset` 唤醒命令)。

## 文件

| 文件           | 作用                                                          |
| -------------- | ------------------------------------------------------------- |
| `sync.sh`      | 同步 payload(导出 → 截断重灌 → 序列重置 → 通知)               |
| `setup.sh`     | 生成 wrapper + plist 并 `launchctl bootstrap`(`--time HH:MM`) |
| `uninstall.sh` | `bootout` + 删 plist(不删数据)                                |

运行态(机外,不入库):`~/.nvy/marketdata-dev-sync/`(`run-scheduled.sh` / `sync.log` 结果 / `launchd.log` 原始输出)。

## 已知限制

- **Mac 睡眠不触发**:用 setup 打印的 `sudo pmset repeat wakeorpoweron ...` 唤醒。
- **非样本股仅近 20 日、无复权因子**:其 forward/backward K 线在近窗内若恰遇除权会微偏(`/quote` 用 none 不受影响)。
- **免密 SSH**:依赖 `~/.ssh` key 非交互(带 passphrase 需进 keychain)。
- **周末/节假日仍跑**:prod 无新数据,重灌同数据,无害(几秒 SSH COPY)。
