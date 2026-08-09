# holdings-sync — 自有持仓本机同步工具

同花顺投资账本（tzzb.10jqka.com.cn）持仓导出 → 服务端导入（025 FR-012）。**自包含、可拷到
任意 Mac 跑**（不依赖 mono-repo workspace；用 Node 22 原生 `fetch` + `playwright-core` 驱动
系统 Chrome）。仅支持 **macOS 笔记本**。

## 能力分级（由浅入深）

| 级     | 能力                                       | 怎么用                                            |
| ------ | ------------------------------------------ | ------------------------------------------------- |
| **L1** | 全手动：自己登录同花顺/下载/手动上传       | 网页导出 + 任意 HTTP 工具调 EP1                   |
| **L2** | 本地脚本一键：自动拉取 + 自动上传          | `pnpm holdings:sync`（手动触发，看 console 结果） |
| **L3** | 定时全自动：每晚到点自跑，跑完弹通知报结果 | `pnpm holdings:setup` 装 launchd 定时             |

## 前置

- macOS + Google Chrome（`/Applications/Google Chrome.app`）
- Node >= 22（原生 `fetch`/`FormData`/`Blob`）
- 依赖：在**工具目录内**装一次 → `cd scripts/holdings-sync && pnpm install`
  （仅 `playwright-core` + `tsx`；在 mono-repo 内跑则复用根 hoisted 依赖，可跳过）
- 目标 server 可达（dev `http://127.0.0.1:3000`；prod `https://api.shintongtech.com`）

> 新 Mac 上跑：clone 仓（或只拷 `scripts/holdings-sync/` 目录）→ 目录内 `pnpm install` →
> 装 Google Chrome → `pnpm holdings:setup`（见下）。

## L2 — 手动一键

```bash
pnpm holdings:sync                                       # 拉取 + 上传 dev
pnpm holdings:sync --base-url https://api.shintongtech.com   # 上传 prod
```

首跑两次一次性登录（之后免登录、自动复用）：

1. **同花顺登录 + 选账户**：脚本以固定 profile（`~/.nvy/chrome-tzzb-profile`）启动调试 Chrome；
   在 Chrome 窗口完成登录**并切到目标账户（如「股票账户」）的「持仓列表」页**后回终端回车。
   找不到按钮时脚本会把 Chrome 窗口**叫到前台**并打印当前页面（CLI 启的窗口默认不抢焦点）。
   首次成功导出后，脚本把该账户页 URL 记到 `~/.nvy/holdings-sync/tzzb-account.json`，**之后每次
   启动直达该账户持仓列表**——不怕 tab 飘到别的账户、不怕窗口看不到，定时（headless）也因此稳。
2. **服务端短信登录**：CLI 输手机号 → 收码 → 输码。refresh token 落 `~/.nvy/holdings-sync.json`
   （chmod 600，按 base-url 分槽），之后每跑自动轮转续期。

分段跑：

```bash
pnpm holdings:fetch                                    # 仅拉取 → ~/.nvy/holdings-sync/<账户名>_YYYYMMDD.xlsx
pnpm holdings:upload                                   # 仅上传（默认取下载目录最新一份）
pnpm holdings:upload --file ~/Downloads/股票账户.xlsx   # 指定文件（跳过拉取）
```

`asOf` 取文件名中的 `YYYYMMDD`；重跑同日导入幂等（服务端整体替换语义，FR-006）。

## L3 — 每晚定时上传产线

```bash
pnpm holdings:setup                                    # 默认产线 + 每天 18:00
pnpm holdings:setup --base-url http://127.0.0.1:3000 --time 18:00   # 自定义
pnpm holdings:setup --skip-login                       # 已 seed 过，仅重装调度
```

`setup` 会：① 校验平台/Chrome/Node；② 引导一次交互首登（同花顺 + 产线短信）seed 凭证；
③ 生成 wrapper `~/.nvy/holdings-sync/run-scheduled.sh`；④ 写 LaunchAgent
`~/Library/LaunchAgents/com.nvy.holdings-sync.plist` 并 `launchctl bootstrap`。

到点后 headless 自动跑（无 TTY、不 prompt），**跑完弹 macOS 桌面通知 + 写 `sync.log` 报结果**。

```bash
# 让 Mac 在 18:00 睡眠时自动唤醒（setup 会打印实际时间，sudo 跑一次）：
sudo pmset repeat wakeorpoweron MTWRFSU 17:58:00
# 手动触发一次验证：
launchctl kickstart -k gui/$(id -u)/com.nvy.holdings-sync
# 卸载（保留凭证，重装免重登）：
pnpm holdings:uninstall
```

**登录态过期处理**：同花顺登录态会周期性失效（自动化无法扫码/短信续）。失效那晚 headless
任务**快速失败**（不挂死）+ 弹通知；收到后手动跑一次 `pnpm holdings:sync`（交互）重登即可，
之后定时恢复。只要每晚正常跑、refresh token 持续轮转，服务端凭证不过期。

## 工作机制（速记）

- **拉取**：`connectOverCDP(127.0.0.1:18800)` attach 常驻 Chrome → 点「数据导出」→ **监听
  浏览器原生下载事件** `page.on('download')` → `saveAs` 落盘 `<账户名>_YYYYMMDD.xlsx`（导出当前
  Chrome 停留的账户，持久 profile 记忆上次选择）。整链失败重试 ×3。
  > ⚠️ 早期「捕获 `/excel/` 请求参数 + 自拼 note 轮询/download URL + base64 回传」方案已废：
  > 多账户 fund_key 差异 + 按 tab 分批触发的 race 会抓到残缺文件（实测丢「持仓数据」sheet）。
  > 原生下载拿到的是与网页手动导出逐字节同源的完整 3-sheet 文件。
- **上传**：读 `~/.nvy/holdings-sync.json` refresh token → 调 003 refresh 轮转（新 refresh
  立即回写）→ 拿 access → 原生 `fetch` multipart POST `/api/v1/portfolio/holdings/import`
  → 打印/通知导入摘要。HTTP 调用走 `api.ts`（Node 原生 fetch，无 `@nvy/api-client` 依赖；
  契约回归由仓内 `apps/mobile/e2e/contract-smoke/portfolio-holdings.contract.ts` 守）。
- **headless 判定**：无 TTY 或带 `--headless` → 非交互；登录失效即抛错不 prompt。

## 故障排查

| 症状                                       | 处置                                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `Chrome 启动失败：18800 端口 30s 内未就绪` | 端口被占：`lsof -i :18800` 查占用；或已有**非调试模式** Chrome 占了 profile，关掉后重跑          |
| 反复提示「未检测到数据导出按钮」           | Chrome 窗口里确认已登录且已进入目标账户的「持仓列表」页；按钮用文本 `数据导出` 定位              |
| headless 报「同花顺登录态可能已过期」      | 手动 `pnpm holdings:sync`（交互）重登一次，定时即恢复                                            |
| 导出文件 sheet 不全（缺持仓数据）          | 确认在账户的「持仓列表」tab 而非空账户；导出的是当前账户，切错账户会导出别的户                   |
| 上传 401 且短信登录也失败                  | 检查 `--base-url` 指向的 server 是否可达、手机号是否注册过                                       |
| 定时没跑                                   | `launchctl print gui/$(id -u)/com.nvy.holdings-sync` 看是否已载；Mac 是否在该时刻醒着/已设 pmset |
| 导入摘要大量 skipped                       | 看摘要里逐行 reason；同花顺导出模板变更需同步 server 解析器                                      |
