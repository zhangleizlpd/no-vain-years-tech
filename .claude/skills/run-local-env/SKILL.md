---
name: run-local-env
description: 一键把 no-vain-years-mono 本地全栈拉起到「可直接手动功能验证」(docker deps PG+Redis → DB schema → code-index SSH 隧道 → server → 真机 Mate50 Metro dev-client)。主 / 辅 worktree 通用(自动探测 env 源与端口,不 hardcode)。触发:用户提"起本地环境 / 拉起全栈 / run local env / 启动本地服务做手动验证 / 本地联调环境 / 把环境都起好 / 准备 mate50 / 真机 dev / mate50 dev";收工提"关掉本地环境 / 停掉本地服务 / 收工 / teardown / 关本地环境"(走 `teardown` 模式,只关进程级服务、容器不动)。全栈模式含 Step 0(dev-client APK 按需本地 Gradle 构建+装机)。
argument-hint: '[backend-only | teardown]（可选；省略=全栈含真机 Metro；backend-only=只起后端到可 curl；teardown=只关进程级服务，容器不动）'
user-invocable: true
disable-model-invocation: false
model: inherit
---

# run-local-env — 本地全栈一键拉起到可手动验证

把 [`ops/runbook/local-dev.md`](../../../ops/runbook/local-dev.md) 的 bring-up 序列做成**可执行编排**:按序拉起每个依赖与服务,每步带 verify gate,最后报「ready + 手动验证入口」。runbook 是完整手册(含 APK 安装/排障),本 skill 是「直接起起来」的执行层 —— 深坑细节指回 runbook,不复述。

## 何时用 / 不用

- **用**:要在本机做手动功能验证(真机点一遍 / 验语音输入 / 验接地引用 / 验行情),需要后端 + DB + 接地 + 真机 Metro 全起好。
- **不用**:只跑测试 / IT / 契约冒烟(那些走 testcontainers + vitest test.env,不需本 skill);只改文档。

## 0. 关键不变量(写命令前必须内化)

1. **主 / 辅 worktree 通用,不 hardcode**。差异:辅 worktree 无 `apps/server/.env`,env 经 root `.envrc`(direnv source 主仓 .env + override `PORT=3001 / EXPO_METRO_PORT=8082 / Redis db1`);主 worktree 自有 `apps/server/.env`(@nestjs/config 自动读,PORT 3000 / Metro 8081)。
2. **每条依赖 env 的命令必须自身 `source .envrc`**。Bash 工具每次调用 = 独立 `zsh -c` 快照,(a) 快照不跑 direnv hook(只挂交互 shell),(b) 快照是时间冻结、读不到 session 后新填的 .env 值,(c) env 不跨 Bash 调用持久。故 source 一次没用 —— **每条命令前缀**:

   ```bash
   [ -f .envrc ] && { set -a; source ./.envrc; set +a; }
   ```

   辅 worktree:这步把主仓 .env(含 CODE_INDEX 三值 + ASR)灌进 process.env + 拿到 PORT/Metro override。主 worktree:无 `.envrc` → 跳过,env 由 server 自读 `apps/server/.env`。

3. **端口一律派生,不写死**:`SERVER_PORT=${PORT:-3000}`、`METRO_PORT=${EXPO_METRO_PORT:-8081}`(在 source 之后取)。
4. **真机不是 Mac**:`localhost` 在手机上指手机自己。**默认走 USB 反向隧道**(`adb reverse tcp:<port> tcp:<port>` 把 Metro + API 两个端口映回 Mac → app 统一用 `localhost`,不依赖 WiFi/IP)。**只在无 USB(纯 WiFi)时**才退回 Mac LAN IP(`ipconfig getifaddr en0`);LAN IP 是打包时内联进 bundle 的死值,Mac IP 漂移(换网/DHCP)或路由器 AP 隔离都会让它**无声失效**(2026-06-25 实证:旧 IP 烤死 bundle + WiFi 断走蜂窝 + 同网段 AP 隔离三连坑)。
5. **长驻进程用 run_in_background**(server / Metro / SSH 隧道)。它们要活过本次会话,别用前台 `&`(会随 Bash 调用结束被收)。

## 模式分流(按 `$ARGUMENTS` 先分支)

- `$ARGUMENTS` 含 **`teardown`** → **跳过下面全部 bring-up**,直接执行 [`## 收工 teardown`](#收工-teardown) 那一段并报告关停结果。**不再起任何服务**。
- `$ARGUMENTS` 含 **`backend-only`** → 跑 bring-up Step 1-4,跳过 Step 0 + Step 5(不碰真机/Metro)。
- 省略 → 全栈 bring-up（Step 0-5;Step 0 = dev-client APK 按需构建+装机)。

## 执行流程(按序;每步 verify 通过才进下一步)

### 0. dev-client APK(按需本地构建;`backend-only`/`teardown` 跳过)

真机 dev-client 是「本地全栈手动验证」的载体 —— 没装它 Step 5 连了也白连。**默认复用已装的**,只在**必要时**本地 Gradle 构建(替 EAS,EAS 额度耗尽/离线时;细节+坑见 runbook § Local Gradle build)。**不每次重建**(JS/TS 改动热重载即可,重建 245MB APK 是浪费)。

```bash
# 0a. 设备在否(USB「安装」开关闲置 ~10min 会自动关,装机前确认开着)
adb devices   # verify: 列出真机序列号 = device(非 unauthorized / 空)
# 0b. 装没装 + 是不是 dev-client(standalone 会跑内嵌 JS、无视 Metro)
adb shell pm list packages 2>/dev/null | grep -q novainyears \
  && adb shell dumpsys package com.shintongtech.novainyears | grep -q DEBUGGABLE \
  && echo "dev-client 已装 → 默认复用" || echo "未装 / 非 dev-client → 需本地构建"
```

判定(按需):

- **未装 / 非 dev-client(无 `DEBUGGABLE`)** → 必须本地构建 + 装。
- 已装 dev-client + **本会话刚加过原生依赖 / 改过 `app.json` 插件 / native 配置 / Expo·RN bump** → 重建(纯 JS/TS 改动**不算**)。
- 否则 → **复用已装,直接进 Step 1**。

构建 + 装(仅在上面判定需要时):

```bash
# 构建:RN0.81 须 JDK17(JAVA_HOME 仅本次覆盖系统默认 21);本机 SDK/JDK 路径(换机需改)。
# run_in_background(首次编 NDK ~28min,.cxx 缓存后增量 ~2-3min)。
JAVA_HOME=~/.sdkman/candidates/java/17.0.19-tem \
ANDROID_HOME=/opt/homebrew/share/android-commandlinetools \
  apps/mobile/android/gradlew -p apps/mobile/android assembleDebug
# 装:跨 keystore(EAS→本地)先卸,否则 INSTALL_FAILED_ABORTED(误导文案,实为签名冲突);
#    复用同一本地 debug keystore 时可省 uninstall 直接 -r。华为会卡屏等你点「安装」。
adb uninstall com.shintongtech.novainyears 2>/dev/null
adb install apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

> 🔑 **原生依赖刚落地的连环坑**:新包进 `node_modules` 后,**已在跑的旧 Metro 即便 `--clear` 也索引不到** → app 报 `UnableToResolveError: 解析 <pkg> 失败`。所以装完新 APK,Step 5 必须**杀掉旧 Metro、起全新进程 + `--clear`**(已 source 在 Step 5 含)。确认包已 autolink 进 APK:`grep -ri <pkg> apps/mobile/android/app/build/generated/autolinking/`。

### 1. 依赖容器(PG + Redis,共享 mbw_poc)

```bash
docker compose -f docker-compose.dev.yml up -d
docker compose -f docker-compose.dev.yml ps   # verify: 两个都 (healthy)
```

> ⚠️ 这套 PG 是**共享**的(09:05 marketdata sync 依赖)。收工**禁** `compose down`,见 runbook § Teardown。

### 2. DB schema

```bash
[ -f .envrc ] && { set -a; source ./.envrc; set +a; }
pnpm -C apps/server exec prisma migrate status   # verify: "up to date"
# 若 pending(新卷): pnpm -C apps/server exec prisma migrate deploy
# 🚨 regen client（即便 migrate up-to-date 也跑）：DB schema 与生成的 client 是两回事——
#   migration 已应用但 client 陈旧（漏 regen）→ Step 4 server build 红
#   `Property '<model>' does not exist on type 'PrismaService'`（2026-06-28 实证 ideationMockup）。
#   generate 幂等 + 廉价（~100ms），无脑跑兜底，省得 build 才暴露。
pnpm -C apps/server exec prisma generate   # verify: "Generated Prisma Client … to …/generated/prisma"
```

### 3. code-index SSH 隧道(接地 grounding 真检索)

server 现走 `CODE_INDEX_PROVIDER=http` → `localhost:7700`(62 的查询 API,公网拦死,prod 走 WireGuard;本机用 SSH -L 等价物,见 runbook § Optional code-index)。**幂等**:已在听就别重起。

```bash
# 3a. 隧道(已 LISTEN 则跳过);否则 run_in_background 跑:
#     ssh -N -L 7700:localhost:7700 -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes mbw-indexer
lsof -nP -iTCP:7700 -sTCP:LISTEN >/dev/null 2>&1 && echo "tunnel up" || echo "need tunnel"
# 3b. verify:
curl -fsS localhost:7700/healthz   # {"ok":true}（healthz 无需 token）
```

> 隧道断 ≠ 业务挂:接地 UC catch → 降级 notice 气泡、会话不中断(FR-008)。所以隧道这步失败可继续(grounding 退化),但要明确告知 user。

### 4. server(后端)

`ASR_PROVIDER=dashscope` 作**命令前缀覆盖** —— @nestjs/config 不覆盖已存在的 process.env,故前缀稳赢 .env 里的 `fake`。

> 🚨 **preflight(2026-06-24 实验实证必加)**:`asr.config.ts` Zod **fail-closed** —— `ASR_PROVIDER=dashscope` 但 `DASHSCOPE_API_KEY` **空** → server boot 直接崩(cryptic Nest DI 堆栈 `DASHSCOPE_API_KEY required when ASR_PROVIDER=dashscope`)。主仓 .env 里这个 key **默认空**(只有 CODE_INDEX token 是实的)。所以启 server 前先判 key:

```bash
[ -f .envrc ] && { set -a; source ./.envrc; set +a; }
if [ -n "$DASHSCOPE_API_KEY" ]; then ASR=dashscope; else ASR=fake; echo "⚠️ DASHSCOPE_API_KEY 空 → 退回 ASR=fake(真语音转写需先把真 key 填进主仓 apps/server/.env)"; fi
ASR_PROVIDER=$ASR npx nx serve server   # run_in_background
```

verify(另起一条,自身派生端口):

```bash
[ -f .envrc ] && { set -a; source ./.envrc; set +a; }
SERVER_PORT=${PORT:-3000}
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:$SERVER_PORT/healthz/live   # 200
# 确认真 provider 都生效:
curl -s http://localhost:$SERVER_PORT/healthz/ready >/dev/null && echo ok
```

> ASR 由上面 preflight 自动选(key 空→fake、key 在→dashscope);要强制 fake 就把 `ASR=fake` 写死。`MARKETDATA_PROVIDER` 继承 shell(通常 live → 真行情);要 mock 行情则前缀 `MARKETDATA_PROVIDER=mock`。

### 5. mobile — 真机 Mate50 dev-client(`$ARGUMENTS` 含 `backend-only` 则跳过本步)

**默认 USB 隧道**:两个端口都 `adb reverse` 映回 Mac,Metro + API 全程走 USB(不碰 WiFi/IP)。先建隧道(幂等,重复执行无害):

```bash
[ -f .envrc ] && { set -a; source ./.envrc; set +a; }
SERVER_PORT=${PORT:-3000}; METRO_PORT=${EXPO_METRO_PORT:-8081}
adb reverse tcp:$METRO_PORT tcp:$METRO_PORT    # Metro
adb reverse tcp:$SERVER_PORT tcp:$SERVER_PORT  # API
adb reverse --list   # verify: 两条都在
```

Metro 起 `localhost` base(经隧道直达 Mac server),带 markets flag。**先查在跑的 Metro 带的是不是对的 base URL** —— 跨会话残留的旧 Metro 常带 stale LAN-IP,`adb reverse` 配了也没用(app 走的是 bundle 里内联的死值,不是隧道),无声让真机「网络异常」(2026-06-26 实证):

```bash
[ -f .envrc ] && { set -a; source ./.envrc; set +a; }
SERVER_PORT=${PORT:-3000}; METRO_PORT=${EXPO_METRO_PORT:-8081}; WANT="http://localhost:$SERVER_PORT"
MPID=$(lsof -ti "tcp:$METRO_PORT" -sTCP:LISTEN 2>/dev/null | head -1)
HAVE=$([ -n "$MPID" ] && ps eww -p "$MPID" 2>/dev/null | tr ' ' '\n' | grep '^EXPO_PUBLIC_API_BASE_URL=' | cut -d= -f2-)
if [ -n "$MPID" ] && [ "$HAVE" = "$WANT" ]; then
  echo "✅ Metro 已在 :$METRO_PORT base=$WANT → 复用,跳过下面启动块"
elif [ -n "$MPID" ]; then
  echo "♻️ Metro :$METRO_PORT base='${HAVE:-未设}'≠'$WANT'(stale)→ 杀掉,走下面 --clear 重起"
  PGID=$(ps -o pgid= -p "$MPID" | tr -d ' '); kill -TERM "-${PGID:-$MPID}" 2>/dev/null; sleep 1
else echo "无 Metro 在跑 → 走下面启动块"; fi
```

> 只认**显式 `=$WANT`** 为可复用:`HAVE` 空虽被代码兜底 `localhost:3000`,但辅 worktree(SERVER_PORT=3001)空=默认 3000=错,故空一律判 stale 重起。

**仅当上面判定「重起 / 无 Metro」时**才跑(判「复用 ✅」则整块跳过)。**run_in_background**:

```bash
[ -f .envrc ] && { set -a; source ./.envrc; set +a; }
SERVER_PORT=${PORT:-3000}; METRO_PORT=${EXPO_METRO_PORT:-8081}
# 备案展示域 base (= server OSS_PUBLIC_BASE_URL):主 worktree 读 apps/server/.env;辅 worktree 经上面 source .envrc 已在 env。
# 🚨 漏传 → 渲染端 origin 白名单空 → mockup / ideation 图的 valid 备案域 URL 被判「脏域」折叠成空态(「暂无设计稿」,2026-06-28 实证)。
OSS_BASE="${OSS_PUBLIC_BASE_URL:-$(grep -E '^OSS_PUBLIC_BASE_URL=' apps/server/.env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')}"
EXPO_PUBLIC_API_BASE_URL="http://localhost:$SERVER_PORT" EXPO_PUBLIC_OSS_PUBLIC_BASE_URL="$OSS_BASE" EXPO_PUBLIC_FEATURE_MARKETS=true \
  pnpm -C apps/mobile exec expo start --dev-client --port $METRO_PORT --clear
```

> `--clear` 清掉可能的旧 LAN-IP 缓存 bundle —— 本块只在 stale/无 Metro 时走,故恒带 `--clear` 无浪费(复用路径已在上面 gate 跳过,稳态不会每次重建)。

连接(冷启吞首个 deep link → 先冷启再发;deep-link 也指 `localhost`,走隧道):

```bash
adb shell am force-stop com.shintongtech.novainyears   # 装过新 APK 必须先 force-stop
adb shell monkey -p com.shintongtech.novainyears -c android.intent.category.LAUNCHER 1
sleep 5
adb shell am start -a android.intent.action.VIEW \
  -d "nvy://expo-development-client/?url=http%3A%2F%2Flocalhost%3A$METRO_PORT"
```

> **无 USB(纯 WiFi)fallback**:把上面 `adb reverse` 两条 + `localhost` 全换成 `LAN=$(ipconfig getifaddr en0)` 的 `$LAN`(Metro env、deep-link 同理)。前提:手机与 Mac 同 WiFi 且路由器无 AP 隔离;Mac IP 一变就得 `--clear` 重起 Metro。**能 USB 就别走这条**。

<!-- -->

> **wrong-APK 陷阱**:手机若装的是 standalone(preview/production)而非 dev-client,会跑内嵌 JS、无视 Metro(你的改动永不生效)。验证 = `adb shell dumpsys package com.shintongtech.novainyears | grep flags=` 含 `DEBUGGABLE`;Metro log 启动后有 `Android Bundled … entry.js`。详见 runbook § wrong-APK trap。APK 安装/重建判定也在 runbook。

## Ready 报告(给 user 的手动验证入口)

全起来后,向 user 报这张表(端口用派生实际值):

| 维度           | 值                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 后端 API       | `http://localhost:<SERVER_PORT>`(真机经 adb reverse 隧道 / Mac 同址;无 USB 时 `http://<LAN>:<SERVER_PORT>`)                          |
| Metro          | `localhost:<METRO_PORT>`(真机 dev-client 经 adb reverse 隧道连;无 USB 时 `<LAN>:<METRO_PORT>`)                                       |
| 登录验证码     | `SMS_GATEWAY=mock` → 不发真短信,看 server log `[MOCK SMS] sent <code>`                                                               |
| 接地 grounding | 真检索经 SSH 隧道 :7700(隧道在 = 真引用;断 = 降级气泡)                                                                               |
| 语音 ASR       | `DASHSCOPE_API_KEY` 非空=dashscope 真转写(北京区 WS;耗真 API);空=自动 fake(确定性,不验真转写)                                        |
| 行情           | 继承 shell `MARKETDATA_PROVIDER`(通常 live)                                                                                          |
| 设计稿/灵感图  | `EXPO_PUBLIC_OSS_PUBLIC_BASE_URL` = 备案展示域(= server `OSS_PUBLIC_BASE_URL`);空则 mockup/图 origin 白名单空 → 渲染折叠「暂无」空态 |

然后一句话告诉 user:打开 Mate50 dev-client → 连上即可手动点验。

## 收工 teardown

**只关本 worktree 的 server + Metro**(按派生端口定位 → 杀其**整个进程组**,一次带走 `nx serve` / `node --watch` 父进程防 respawn)。**绝不按进程名 grep**(`pkill -f "nx serve"` 会跨 worktree 误杀同名进程),靠端口锚定天然 worktree-scoped(主 3000/8081、辅 3001/8082 互不撞):

```bash
[ -f .envrc ] && { set -a; source ./.envrc; set +a; }
SERVER_PORT=${PORT:-3000}; METRO_PORT=${EXPO_METRO_PORT:-8081}

# 按本 worktree 派生端口找 listener → 杀其进程组(负 PGID 带走 nx/watch 父,防 respawn)。
for P in "$SERVER_PORT" "$METRO_PORT"; do
  LPID=$(lsof -ti "tcp:$P" -sTCP:LISTEN 2>/dev/null | head -1)
  [ -z "$LPID" ] && continue
  PGID=$(ps -o pgid= -p "$LPID" 2>/dev/null | tr -d ' ')
  if [ -n "$PGID" ]; then kill -TERM "-$PGID" 2>/dev/null; else kill -TERM "$LPID" 2>/dev/null; fi
done

# 只撤本 worktree 的 adb reverse 两条(不 --remove-all,免动其他 worktree / 设备上别的映射)。
adb reverse --remove "tcp:$SERVER_PORT" 2>/dev/null
adb reverse --remove "tcp:$METRO_PORT" 2>/dev/null

# verify:本 worktree 两端口应已空(respawn 漏网会在这里现形)。
sleep 1
for P in "$SERVER_PORT" "$METRO_PORT"; do
  lsof -ti "tcp:$P" -sTCP:LISTEN >/dev/null 2>&1 \
    && echo "⚠️ :$P 仍在听(进程组未杀净) → 重跑本段;持续则 kill -KILL 该 listener" \
    || echo "✅ :$P freed"
done
```

> **code-index SSH 隧道(:7700)是跨 worktree 共享单隧道**(不变量 #3 幂等),本 teardown **默认不动它** —— 关掉会断掉其他 worktree 仍在跑的 server 的接地。确认本机已无任何 worktree server 在用、要彻底清时才单独:`pkill -f "ssh -N -L 7700"`。

<!-- -->

> **禁** `docker compose -f docker-compose.dev.yml down` —— 共享 PG,09:05 marketdata sync 依赖。本 teardown **只关进程级服务,容器原样保留**;确需回收容器才单独 down(见 runbook § Teardown)。

## 反模式(别犯)

1. ❌ 只在开头 source 一次 `.envrc` —— env 不跨 Bash 调用持久,**每条命令**都要自带 source 前缀。
2. ❌ 写死端口 3000/8081 —— 辅 worktree 是 3001/8082,必须派生。
3. ❌ 真机默认用 Mac LAN IP —— IP 漂移/AP 隔离会**无声挂掉**(2026-06-25 三连坑);默认 `adb reverse` 两个端口 + `localhost`,LAN IP 仅无 USB 时 fallback。
4. ❌ `compose down` 共享 PG —— 砸掉 marketdata sync。
5. ❌ 前台 `&` 跑 server/Metro/隧道 —— 用 run_in_background,否则随 Bash 调用结束被收。
6. ❌ 看到 `ASR_PROVIDER=fake` 在 .env 就以为没法真转写 —— 命令前缀覆盖(@nestjs/config 不覆盖已存在 process.env)。
7. ❌ teardown 用 `pkill -f "nx serve"` / `adb reverse --remove-all` / 杀 :7700 —— 全是**跨 worktree 误伤**:进程名 grep 会连别的 worktree 的 server 一起杀、`--remove-all` 撤掉别人映射、:7700 是共享隧道。只按**本 worktree 派生端口**锚定 + 杀进程组,7700 默认不动。
8. ❌ 每次「准备 mate50」都重建 APK —— 245MB 构建是浪费。Step 0 **默认复用已装 dev-client**,只在未装 / 非 dev-client / 本会话刚动过原生层(native dep·app.json 插件·SDK·RN bump)时才建;纯 JS/TS 改动走热重载。
9. ❌ 见 Metro 端口已在听就当「已起好」直接复用 —— 跨会话残留的旧 Metro 可能带 **stale LAN-IP** base URL(`adb reverse` 救不了,app 走 bundle 内联死值)→ 真机无声「网络异常」。Step 5 必须 `ps eww` 核对在跑 Metro 的 `EXPO_PUBLIC_API_BASE_URL`==`localhost:$SERVER_PORT`,不符则杀掉 `--clear` 重起(2026-06-26 实证)。
10. ❌ Metro 起时只传 `EXPO_PUBLIC_API_BASE_URL` 漏 `EXPO_PUBLIC_OSS_PUBLIC_BASE_URL` —— 渲染端 origin 白名单空 → mockup / ideation 图的 valid 备案域 URL 被判脏域,屏**无声折叠成「暂无设计稿」空态**(API 200 拿到产物却不渲)。Step 5 命令两个 `EXPO_PUBLIC_*` 都要带,值 = server `OSS_PUBLIC_BASE_URL`(2026-06-28 实证)。
