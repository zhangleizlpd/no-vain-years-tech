---
name: mono-worktree
description: no-vain-years-mono 仓 per-feature git worktree 管理 + 资源隔离（server PORT / Expo Metro PORT / Redis db 3 维；PG 共享 mbw_poc 含 marketdata 种子，不再 per-feature 隔离 DB）。激活时机：用户提"帮我开 worktree / 创建 feature 工作区 / 并行新分支 / 隔离 server 端口 / 多 feature 同时跑 / feat-open / feat-close / feat-list / feat-claude"，或想从 main 切出独立工作目录避免与主 cwd 抢端口。提供 4 个 zsh 命令（源 ~/.zsh/mono-worktree.sh）+ 资源分配机制 + 关键反模式。
model: inherit
---

# mono-worktree — per-feature 工作区一键开关

## 1. 何时用

solo dev 在 mono 仓需要**并行**多个 feature（如同时跑两个 SDD 分支调试 / 一个分支等 CI 另一分支动手），单 cwd 模式会撞 server PORT (3000) / Metro PORT (8081) / Redis db 0。

每个 worktree 自动分配独占 PORT/Metro/Redis db，互不干扰。**PG 数据库统一共享 `mbw_poc`**（含 marketdata 种子等 dev 数据）——per-feature 隔离 DB 已废弃（空库进不了依赖行情数据的流程，如预警建条件）。

**不用的场景**：单 feature 串行开发 — main cwd 直接干就行，多此一举。

## 2. 4 个命令

| 命令                   | 作用                                                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `feat-open <branch>`   | 开 worktree（自动 branch attach/create）+ 分配 PORT/Metro/Redis db + 写 `.envrc`（PG 指共享 `mbw_poc`）+ `pnpm install --frozen-lockfile` |
| `feat-close <branch>`  | 删 worktree + 删本地分支（PG 共享 `mbw_poc`，**绝不 drop**）                                                                              |
| `feat-claude <branch>` | `cd` 进 worktree + `export CC_NS=<suffix>` + 启 `claude`（独立 memory pool）                                                              |
| `feat-list`            | 列所有 worktree + 容器目录磁盘占用 + 遗留 `mbw_*` per-feature DB（旧版残留，可手工清）                                                    |

## 3. Branch 命名（两套并行，per `docs/conventions/git-workflow.md`）

| 类型   | 格式             | 示例                           |
| ------ | ---------------- | ------------------------------ |
| SDD    | `NNN-<slug>`     | `feat-open 003-pkm-link-graph` |
| 非 SDD | `<type>/<kebab>` | `feat-open chore/docs-cleanup` |

regex 校验：`^[a-z0-9][a-z0-9/-]*[a-z0-9]$`。**首尾必须字母/数字，禁大写**。

## 4. 资源隔离机制

启动时 `feat-open` 写副 worktree 根 `.envrc`，注入 4 个 override 字段，覆盖主仓 `apps/server/.env` 默认值。**`DATABASE_URL` 恒指共享 `mbw_poc`**（含 marketdata 种子）；隔离仅 PORT/Metro/Redis db 三维：

```bash
export DATABASE_URL="postgresql://mbw:mbw@localhost:5433/mbw_poc"  # 共享，所有 worktree 同库
export REDIS_URL="redis://localhost:6380/<redis_db>"
export PORT=<server_port>          # 3001 起递增
export EXPO_METRO_PORT=<metro_port> # 8082 起递增
```

**双信号源分配**（每次 `feat-open` 都跑）：

- 端口：`lsof -i :p LISTEN`（实测）+ 扫所有副 worktree `.envrc` 已分配值
- Redis db：Redis `dbsize > 0`（实测）+ `.envrc` 已分配

主仓占 server 3000 / Metro 8081 / Redis db 0。副 worktree 从 3001 / 8082 / db 1 起。**PG 全员共享 `mbw_poc`**（含 dev 种子数据，所以新 worktree 立即可跑依赖行情/数据的流程）。

## 5. 关键工作流

### 开 feature

```bash
# SDD: 先跑 spec-kit specify 自动建 NNN-<slug> 分支
/speckit-specify "pkm link graph"
# → 自动 git checkout -b 003-pkm-link-graph

# 然后开 worktree（attach 已存在分支）
feat-open 003-pkm-link-graph
# → ✅ 输出含 server PORT / Metro PORT / DB 名 / 启动命令提示
```

### 在 worktree 内开发

```bash
cd ~/Documents/projects/no-vain-years-mono-003-pkm-link-graph

# 启 server（PORT 已通过 direnv 注入）
nx serve server

# 启 mobile（Metro PORT 需手带 --port，Expo 不读 env）
nx serve mobile -- --port $EXPO_METRO_PORT

# 启独立 Claude session（独立 memory pool，不污染主仓）
export CC_NS=003-pkm-link-graph
claude
```

### 关 feature

```bash
# 删 worktree + 本地分支；PG 共享 mbw_poc，不触碰数据
feat-close 003-pkm-link-graph
```

## 6. 关键反模式

- ❌ **绕过 git worktree remove 手工 `rm -rf` 副 wt 目录** → `feat-open` 同名 branch 时会 stale metadata 报错。修：`git -C <mono> worktree prune` 后再开
- ❌ **副 worktree 内改 `.envrc` 手工换端口** → 下次 `feat-open` 端口扫描会把改后值当已分配，可能撞号。改 `.envrc` 后跑 `direnv allow` 让 hook 重读
- ❌ **以为各 worktree 数据互相隔离 → 在副 worktree 跑破坏性 DB 操作（truncate / migrate reset / drop schema）** → PG 现共享 `mbw_poc`，会**波及所有 worktree + 主仓**的 dev 数据。破坏性 DB 操作前确认影响面，必要时先 `pg_dump` 备份
- ⚠️ **schema 漂移**：共享库的 migration 状态被所有分支共用。某分支 `migrate deploy` 新迁移后，切回旧分支跑 server 可能 schema 超前（一般兼容；不兼容的破坏性迁移需协调）。同理新 worktree 起 server 前若本分支含未应用迁移，先 `pnpm -C apps/server exec prisma migrate deploy`
- ❌ **关某个 worktree 的服务时按进程名杀（`pkill -f "nx serve"` / `expo`）或 `adb reverse --remove-all`** → 各 worktree 同名进程命令行一致，grep 区分不了 → **跨 worktree 误杀别人的 server / 撤别人的端口映射**。正确：按**本 worktree 派生端口**锚定 listener → 杀其进程组；`run-local-env teardown` 已按此实现（共享 `:7700` code-index 隧道默认不动）

## 7. 故障排查

| 症状                                         | 排查                                                                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `❌ PG container mbw-poc-postgres 未在跑`    | `cd <mono> && docker compose -f docker-compose.dev.yml up -d`                                                              |
| `pnpm install` 失败 lockfile drift           | 进 wt 手工 `pnpm install`（不 frozen），feat-open 已 echo 提示但不 rollback                                                |
| worktree 跑 server 启动报 `EADDRINUSE: 3001` | `.envrc` 未被 direnv 加载 → `cd $wt && direnv allow`                                                                       |
| 新 worktree server 起不来 / 找不到表         | 共享 `mbw_poc` 缺本分支迁移 → `pnpm -C apps/server exec prisma migrate deploy`；或 Prisma client stale → `prisma generate` |
| 搜股票/行情全空，进不了依赖数据的流程        | 旧 worktree 还指 per-feature 空库 → 改 `.envrc` 的 `DATABASE_URL` 库名为 `mbw_poc` + `direnv allow` + 重启 server          |

## 8. 与其他 skill 协同

- `commit-commands:clean_gone` 清理 [gone] 分支时**附带**清 git worktree 元数据；PG 已共享 `mbw_poc` 无 per-feature DB 可残留，Redis db 随 `.envrc` 删除自然释放。建议先 `feat-close` 再 `clean_gone`
- `speckit-implement` 在 worktree 内跑没问题；tasks.md `[X]` flip + commit 走副 worktree git 即可
- `claude-mem` (env-gated `CLAUDE_MEM_ENABLE=1`) 在 worktree 内独立 pool 工作（用户已选独立 pool 方向，不桥接主仓）

## 9. 文件位置

- 脚本：`~/.zsh/mono-worktree.sh`（用户态）
- ~/.zshrc source：`source ~/.zsh/mono-worktree.sh`（行 148）
- 老版本（Java 三仓）：`~/.zsh/_archived/feat-worktree.sh.archived-2026-05-21`
