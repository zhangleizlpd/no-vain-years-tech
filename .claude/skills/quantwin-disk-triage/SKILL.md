---
name: 'quantwin-disk-triage'
description: '代号 quant-win（实盘交易终端宿主，Windows Server + 云助手 + 无 SSH）磁盘不足的完整闭环处置：拉数据 → 归因 → 分级回收 → 验证。触发：用户提"quant-win 磁盘告警 / 实盘机磁盘 / 磁盘不足 / 磁盘满了 / quantwin-health 告警 / 收到磁盘告警 / C 盘满 / WinSxS / 组件存储 / DISM 清理 / quantwin-disk-triage"，或 com.nvy.quantwin-health 推来 🟡/🔴 告警后。也可用于「机器没告警但我想看看它状态」的例行体检。'
argument-hint: '[check | full]（可选；省略=按告警走完整流程；check=只拉快照做体检不清理）'
user-invocable: true
disable-model-invocation: false
model: inherit
---

# quantwin-disk-triage — 实盘机磁盘不足闭环处置

代号 `quant-win` 是**实盘交易终端宿主**：无 SSH（仅 RDP + 云助手）、无 CloudMonitor agent、交易软件跑在**手工 RDP 交互式会话**里且无任何自启动机制。

三条由此推出的事实，决定了本流程的形状：

1. **唯一远程通道是云助手** `aliyun ecs RunCommand`，输出有体积上限（约 24KB）⇒ 远端脚本必须自己聚合，不能回传原始数据。
2. **重启 = 交易系统停机直到有人 RDP 进去手动拉起**（无服务注册 / 无自动登录 / 无启动项 / 无登录触发任务）⇒ 重启永远是人的决定。
3. **它是实盘机** ⇒ 任何写操作的爆炸半径包含资金。

> 机器专属真值（实例 ID / 公网 IP / 账号 UID / 操作账号 / 交易终端安装路径 / 加固待办）在
> [`docs/private/runbook/stock-quant-win-server.md`](../../../docs/private/runbook/stock-quant-win-server.md)（local-only，不入库）。
> 本 skill **只写方法与判据，一切标识符走 env**，per [information-boundary.md](../../../docs/conventions/information-boundary.md)。

---

## 🚨 三道无条件闸

**这三道闸不带任何条件** —— 不是「除非用户已授权」、不是「除非是用户显式要求的」。那类条件从执行方的上下文里**观测不到**（per [claude-config-layout.md](../../../docs/conventions/claude-config-layout.md) §护栏措辞），写进来等于没有闸。

| 闸              | 触发时机                                  | 必须做的                                                                                      |
| --------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| **闸 1 · 删除** | 任何删文件 / 清目录 / 卸组件之前          | 列出**每一项 + 预估回收量 + 风险等级**，停下等用户逐项确认                                    |
| **闸 2 · 重启** | 任何 `shutdown` / `Restart-Computer` 之前 | 明确告知「交易系统会停机直到你 RDP 手动拉起」，停下等确认。**永不自主重启**                   |
| **闸 3 · DISM** | `/StartComponentCleanup` 之前             | 报告可用空间与挂起状态，停下等确认。`/ResetBase` **额外**说明「所有已装更新变为永久不可卸载」 |

**闸之外还有两条禁令：**

- ❌ **永不强杀 `TiWorker` / `TrustedInstaller`**。有挂起服务事务时强杀可能让组件存储进入不一致状态 —— 这是实盘机上最不能接受的失败模式。停不下来就**如实报告并放弃该项**。
- ❌ **永不动业务数据目录** —— 交易组件在 `C:\` 根下的几个机器级数据目录，以及用户 profile 里的策略与日志。日志**有审计留存要求**，2026-08-15 已明确。具体目录名见私有 runbook。

---

## 流程五阶段

### 阶段 0 · 解析连接参数

```bash
. ~/.nvy/fleet.env              # NVY_QUANT_WIN_ECS_ID
. ~/.nvy/quantwin-health.env    # NVY_QUANTWIN_PROCS / _ALIYUN_PROFILE / _REGION / 阈值
```

⚠️ 现有 RAM 子账号**只有 4 个 ECS 权限**：`RunCommand` / `DescribeInvocationResults` / `DescribeInstances` / `DescribeCloudAssistantStatus`。
`DescribeDisks` / `DescribeSnapshots` / `RebootInstance` 一律 `Forbidden.RAM` ⇒ **云盘信息、快照、强制重启都拿不到 / 做不了**，别浪费往返去试。要扩容或打快照，只能让用户去控制台。

### 阶段 1 · 快照体检（< 30s，永远先跑这个）

一次往返拿到判断所需的全部快事实。**不要**一上来就跑深扫（阶段 2 要 ~8 分钟）。

脚本见下方「阶段 1 采集脚本」。跑法（`base64` + 轮询是每次都要的样板，直接照抄）：

```bash
. ~/.nvy/fleet.env; . ~/.nvy/quantwin-health.env
PS=<script.ps1>

# ── 发送前强制自检（见下方陷阱 4；跳过它 = 可能拿到「成功但空输出」而毫无察觉）──
LC_ALL=C grep -n $'[^\t -~]' "$PS" && { echo "🔴 载荷含非 ASCII —— PowerShell 会静默解析失败。改成纯 ASCII 再发。"; exit 1; }
[ "$(head -c 3 "$PS" | xxd -p)" = "efbbbf" ] && { echo "🔴 载荷有 UTF-8 BOM —— 同样静默失败。去掉 BOM。"; exit 1; }

B64=$(base64 -i "$PS" | tr -d '\n')
INV=$(aliyun ecs RunCommand --profile "${NVY_QUANTWIN_ALIYUN_PROFILE:-mbw-server}" \
  --region "${NVY_QUANTWIN_REGION:-cn-shanghai}" --InstanceId.1 "$NVY_QUANT_WIN_ECS_ID" \
  --Type RunPowerShellScript --Name nvy-triage --ContentEncoding Base64 \
  --Timeout 900 --CommandContent "$B64" | sed -n 's/.*"InvokeId": *"\([^"]*\)".*/\1/p')
# 轮询：>2min 的脚本用 run_in_background，别前台干等
for i in $(seq 1 60); do
  R=$(aliyun ecs DescribeInvocationResults --profile "${NVY_QUANTWIN_ALIYUN_PROFILE:-mbw-server}" \
      --region "${NVY_QUANTWIN_REGION:-cn-shanghai}" --InvokeId "$INV" --InstanceId "$NVY_QUANT_WIN_ECS_ID")
  echo "$R" | grep -q '"InvocationStatus": "Running"' || break
  sleep 10
done
echo "$R" | sed -n 's/.*"Output": *"\([^"]*\)".*/\1/p' | head -1 | base64 -D
```

> 轮询期间可以先给用户「已确认的部分」，但**别在数据回来前写结论**。

### 阶段 2 · 深扫归因（~8 min，仅当阶段 1 判定确实空间不足）

见 [`references/deep-scan.md`](references/deep-scan.md)。它给出**权威**的组件存储占用（`DISM /AnalyzeComponentStore`）+ 目录分布 + 大文件 + 日志增长率。

### 阶段 3 · 归因与定量（不动手，只出账）

产出一张表：**每一项占多少 · 是冗余还是本体 · 可否回收 · 回收后是否会回涨**。
必须能回答「加起来对得上已用空间吗」—— 对不上就是量纲错了（见下方陷阱 1）。

### 阶段 4 · 分级回收（每一档过闸 1）

见 [`references/reclaim-recipes.md`](references/reclaim-recipes.md)（**批准后再读**，破坏性配方不提前进上下文）。

顺序纪律：**先拿零风险的小项腾出余量，再动 DISM** —— `StartComponentCleanup` 自身需要可用空间才能跑，在几十 MB 的盘上直接跑大概率失败。

### 阶段 5 · 验证（不许只看退出码）

| 验什么                      | 怎么验                                                               |
| --------------------------- | -------------------------------------------------------------------- |
| 空间真的回收了              | `fsutil volume diskfree C:` 前后对比                                 |
| 挂起状态清了                | `RebootPending` / `PendingFileRename` / `PackagesPending` 全 False   |
| 组件存储真的降了            | 再跑一次 `AnalyzeComponentStore`，与阶段 2 **同口径**对比            |
| **交易系统还活着 / 已恢复** | 进程数 + 监听端口 + **外部已建连数** + 业务数据目录 mtime 是否在推进 |
| 告警侧一致                  | `bash ~/.nvy/quantwin-health/probe.sh` 跑一次，看判定与实际一致      |

**重启过的话，交易系统一定是停的** —— 明确告诉用户要 RDP 进去手动拉起，并给出可执行文件路径（从阶段 1 采集的进程 path 里取，别凭记忆写）。

---

## 阶段 1 采集脚本

```powershell
$ErrorActionPreference='SilentlyContinue'
$PROCS = @('__FILL_FROM_NVY_QUANTWIN_PROCS__')   # substituted from $NVY_QUANTWIN_PROCS

Write-Output "===== VOLUME ====="
fsutil volume diskfree C:

Write-Output "`n===== PENDING STATE ====="
$cbs='HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing'
Write-Output ("RebootPending    : {0}" -f (Test-Path "$cbs\RebootPending"))
Write-Output ("RebootInProgress : {0}" -f (Test-Path "$cbs\RebootInProgress"))
Write-Output ("PackagesPending  : {0}" -f (Test-Path "$cbs\PackagesPending"))
if (Test-Path "$cbs\SessionsPending") {
  $p=Get-ItemProperty "$cbs\SessionsPending"
  # NOTE: key present but all values 0 == empty placeholder, NOT a stuck transaction.
  #       Never conclude from key existence alone; print the values.
  (Get-Item "$cbs\SessionsPending").Property | ForEach-Object { Write-Output ("  SessionsPending.{0} = {1}" -f $_, $p.$_) }
}
$pfr=(Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager' -Name PendingFileRenameOperations).PendingFileRenameOperations
Write-Output ("PendingFileRename: {0} entries" -f $(if($pfr){$pfr.Count}else{0}))
Write-Output ("TiWorker running : {0}" -f [bool](Get-Process TiWorker -EA SilentlyContinue))

Write-Output "`n===== WINDOWS UPDATE : last 8 ====="
try {
  $s=(New-Object -ComObject Microsoft.Update.Session).CreateUpdateSearcher()
  $n=$s.GetTotalHistoryCount()
  if($n -gt 0){ $s.QueryHistory(0,[Math]::Min(8,$n)) | ForEach-Object {
    $rc=switch($_.ResultCode){1{'InProgress'}2{'Succeeded'}3{'SucceededWithErrors'}4{'FAILED'}5{'Aborted'}default{'?'}}
    Write-Output ("  {0}  {1,-12} hr=0x{2:X8}  {3}" -f $_.Date,$rc,$_.HResult,$_.Title) } }
} catch { Write-Output "  history query failed" }

Write-Output "`n===== WU POLICY (auto-update must stay OFF) ====="
$au='HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU'
if(Test-Path $au){ (Get-Item $au).Property | ForEach-Object { Write-Output ("  {0} = {1}" -f $_,(Get-ItemProperty $au -Name $_).$_) } }
else { Write-Output "  AU policy key ABSENT -> auto-update is ON. This is a regression." }

Write-Output "`n===== TRADING PROCESSES (owner + path discovers the profile dir) ====="
$tp=Get-CimInstance Win32_Process | Where-Object { $n=$_.Name -replace '\.exe$',''; $PROCS -contains $n }
if(-not $tp){ Write-Output "  NONE RUNNING" }
foreach($p in $tp){
  $o=Invoke-CimMethod -InputObject $p -MethodName GetOwner
  $ps=Get-Process -Id $p.ProcessId -EA SilentlyContinue
  Write-Output ("  {0,-16} pid={1,-6} owner={2}\{3} sess={4} ws={5:N0}MB started={6}" -f `
    $p.Name,$p.ProcessId,$o.Domain,$o.User,$p.SessionId,($ps.WS/1MB),$ps.StartTime)
  Write-Output ("       path={0}" -f $p.ExecutablePath)
}
$pids=@($tp | ForEach-Object { $_.ProcessId })
if($pids.Count -gt 0){
  Write-Output "  -- listening --"
  Get-NetTCPConnection -State Listen | Where-Object { $pids -contains $_.OwningProcess } |
    ForEach-Object { Write-Output ("     {0}:{1} pid={2}" -f $_.LocalAddress,$_.LocalPort,$_.OwningProcess) }
  Write-Output "  -- established OUTBOUND (external gateway = real liveness) --"
  Get-NetTCPConnection -State Established | Where-Object {
    $pids -contains $_.OwningProcess -and $_.RemoteAddress -notmatch '^(127\.|::1$)' } |
    ForEach-Object { Write-Output ("     -> {0}:{1} pid={2}" -f $_.RemoteAddress,$_.RemotePort,$_.OwningProcess) }
}

Write-Output "`n===== INTERACTIVE SESSIONS ====="
quser 2>&1 | Out-String

Write-Output "`n===== KNOWN RECLAIMABLE BUCKETS (cheap, no recursion of C:) ====="
function DirMB($p){ $b=(Get-ChildItem $p -Recurse -File -Force -EA SilentlyContinue | Measure-Object Length -Sum).Sum; if($null -eq $b){0} else {[math]::Round($b/1MB,1)} }
foreach($b in @(
  'C:\Windows\SoftwareDistribution\Download','C:\Windows\Temp','C:\Windows\Logs',
  'C:\Windows\Installer','C:\Windows\Prefetch','C:\Windows\Minidump','C:\$Recycle.Bin',
  # Added 2026-08-15 after a deep scan surfaced a single 300MB .evtx that stage 1 was blind to.
  'C:\Windows\System32\winevt\Logs')){
  if(Test-Path $b){ Write-Output ("  {0,9:N1} MB  {1}" -f (DirMB $b),$b) } else { Write-Output ("     absent  {0}" -f $b) }
}
Get-ChildItem 'C:\Windows\Logs\CBS' -File -Force -EA SilentlyContinue |
  ForEach-Object { Write-Output ("  {0,9:N1} MB  CBS\{1}" -f ($_.Length/1MB),$_.Name) }

Write-Output "`n===== SHADOW COPIES / PAGEFILE / HIBER ====="
# NOTE: do NOT filter this with Select-String on localized words -- the payload must stay
#       pure ASCII (see the encoding trap below). Output is short; print all of it.
vssadmin list shadowstorage 2>&1 | Out-String
Get-Item C:\pagefile.sys,C:\hiberfil.sys,C:\swapfile.sys -Force -EA SilentlyContinue |
  ForEach-Object { Write-Output ("  {0,9:N0} MB  {1}" -f ($_.Length/1MB),$_.Name) }

Write-Output "`n===== MAINTENANCE TASKS (all three were broken on 2026-08-15) ====="
Get-ScheduledTask -TaskPath '\Microsoft\Windows\Servicing\*' -EA SilentlyContinue | ForEach-Object {
  $i=Get-ScheduledTaskInfo $_
  Write-Output ("  {0,-26} state={1,-9} last={2} rc=0x{3:X8}" -f $_.TaskName,$_.State,$i.LastRunTime,$i.LastTaskResult) }
foreach($tp2 in @('\Microsoft\Windows\DiskFootprint\*','\Microsoft\Windows\DiskCleanup\*','\Microsoft\Windows\AppxDeploymentClient\*')){
  Get-ScheduledTask -TaskPath $tp2 -EA SilentlyContinue | ForEach-Object {
    $i=Get-ScheduledTaskInfo $_
    Write-Output ("  {0,-40} state={1,-9} rc=0x{2:X8}" -f ($_.TaskPath+$_.TaskName),$_.State,$i.LastTaskResult) } }

Write-Output "`n===== MONITORING PRESENCE ====="
$cm=Get-Service | Where-Object { $_.Name -match 'CmsGoAgent|argusagent|CloudMonitor' }
if($cm){ $cm | ForEach-Object { Write-Output ("  {0} {1}" -f $_.Name,$_.Status) } }
else { Write-Output "  no CloudMonitor agent (expected; monitoring lives off-box)" }
```

`__FILL_FROM_NVY_QUANTWIN_PROCS__` 要用 `$NVY_QUANTWIN_PROCS` 的值替换成 PS 字符串数组，例如
`NVY_QUANTWIN_PROCS=a,b,c` → `@('a','b','c')`。**不要把进程名写进本文件**（仓公开）。

---

## 判据

| 信号                                            | 含义                                                                       | 动作                          |
| ----------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------- |
| 可用 < `NVY_QUANTWIN_DISK_CRIT_MB`（默认 2048） | 🔴 已在故障区间 —— 写失败会静默丢数据，不弹「磁盘已满」                    | 走完整流程                    |
| 可用 < `NVY_QUANTWIN_DISK_WARN_MB`（默认 4096） | 🟡 有余量，可从容处理                                                      | 走完整流程但不必急            |
| WU 历史出现 `0x80070070`                        | = `ERROR_DISK_FULL`，系统自己承认盘满                                      | 决定性证据，不用再推断        |
| WU 历史出现 `0x80240034`                        | = `WU_E_DOWNLOAD_FAILED`，通常是盘满的次生                                 | 结合上一条看                  |
| `CBS.log` > 100 MB                              | servicing 在反复重试失败并刷日志（正反馈）                                 | 它本身是症状也是占用          |
| `RebootPending = True`                          | DISM 大概率拒绝执行；`CBS.log`/`Download` 也删不掉（句柄被 TiWorker 持有） | **重启在关键路径上** → 过闸 2 |
| `AU policy key ABSENT` 或 `NoAutoUpdate != 1`   | 自动更新被恢复了 —— 这台机曾被设成**每天凌晨 3 点自动装更新+重启**         | 立刻报告，这比磁盘更危险      |
| 交易进程为 0                                    | 交易系统停摆                                                               | 立刻报告 + 给出手动拉起路径   |

⚠️ **腾出空间会引爆已挂起的更新** —— 更新装不上只是因为盘满；空间一恢复它就会成功并要求重启。所以**先确认自动更新是关的**（`NoAutoUpdate=1`），再腾空间。顺序反了等于主动引爆。

---

## 已知基线与三个陷阱（2026-08-15 实测，别重新踩）

### 陷阱 1 · PowerShell 目录体积不去重硬链接 —— 当天踩了 3 次

`Get-ChildItem -Recurse | Measure-Object Length` 按**目录项**累加，同一份数据被 N 个硬链接引用就算 N 次。Windows 系统盘全是硬链接农场：

| 当天报出的虚高值     | 真实值        | 差距来源                                                                               |
| -------------------- | ------------- | -------------------------------------------------------------------------------------- |
| `C:\Windows` 35.1 GB | —             | WinSxS 与 System32 等互为硬链接                                                        |
| Edge 三件套 3.1 GB   | **约 850 MB** | `Edge` / `EdgeCore` / `EdgeCore\Optimized` / `EdgeWebView` 四处指向同一份 `msedge.dll` |

**硬规则**：目录体积一旦用于下结论，必须先验硬链接，否则不许下结论。

```powershell
# NOTE: quote the placeholder. Bare <...> makes PowerShell choke ("< is reserved"),
#       so an unquoted placeholder turns this snippet into a copy-paste trap.
fsutil hardlink list '<biggest-file>'                    # lists every path sharing that data
Dism.exe /Online /Cleanup-Image /AnalyzeComponentStore   # the only authoritative WinSxS number
```

**自检**：各目录加起来 > 磁盘已用量 ⇒ 一定有重复计数。当天 49.9 GB > 39.9 GB 就是这么发现的。

### 陷阱 2 · 「返回码 0」不等于「干成了事」

`\Microsoft\Windows\Servicing\StartComponentCleanup` 计划任务 `LastTaskResult=0x00000000`，而同期组件存储仍有 **14.39 GB** 待清。它受 1 小时超时 + 30 天宽限期限制，叠加盘满写不进去 ⇒ **成功地什么都没做**。

⇒ 不要因为「自带任务是健康的」就跳过手动 DISM。当天手动跑 8 分 18 秒回收 **5.45 GB**。

同机另两个自动清理机制也是坏的：`DiskFootprint\StorageSense` = `0x80040154`（类未注册）、`AppxDeploymentClient\Pre-staged app cleanup` = Disabled。

### 陷阱 3 · 「异常大」不等于「异常」

| 项                     | 当天预估 | 实得        | 真相                                                                                                         |
| ---------------------- | -------- | ----------- | ------------------------------------------------------------------------------------------------------------ |
| Defender 特征库 869 MB | −600 MB  | **−101 MB** | `Backup`(427) + `Default` 出厂基线(212) + 当前(212) —— **设计如此，各有用途**，且删了会重新下回来。净收益≈0  |
| 旧版 AppX 370 MB       | −370 MB  | **−0 MB**   | `Remove-AppxPackage` 只取消注册，**磁盘回收延迟到重启**（且该机清理任务被禁用）。当天重启后才连带释放约 1 GB |

⇒ 报回收量之前先问「它会不会回涨」「是不是延迟释放」。**宁可说不知道，别给一个编出来的数字。**

### 陷阱 4 · 云助手上的 PowerShell 载荷必须**纯 ASCII 且无 BOM**，否则静默失败

2026-08-15 对照实验实测（同一段逻辑四个变体）：

| 载荷                                                 | 结果                            |
| ---------------------------------------------------- | ------------------------------- |
| 纯 ASCII                                             | ✅ 正常                         |
| 含中文（注释 + 字符串），无 BOM                      | ✅ **正常** —— 中文本身不是问题 |
| 含 **emoji**（如 `⚠️` = U+26A0 + U+FE0F 变体选择符） | 🔴 **空输出**                   |
| 含中文 + **UTF-8 BOM**                               | 🔴 **空输出**                   |

失败形态是**最恶劣的一种**，三项全部报「成功」：

```text
InvocationStatus = Success    ExitCode = 0    ErrorCode = ''    ErrorInfo = ''
Output = <空>                 StartTime → FinishedTime 仅 1 秒（根本没执行，解析就挂了）
```

**⇒ 本 skill 所有 PowerShell 载荷一律纯 ASCII。** 注释写英文，别用 emoji，别用 `—` / `→` 之类的
非 ASCII 标点，也别用中文做 `Select-String` 的匹配词（本地化输出要匹配就整段打印，在分析端过滤）。

**别靠记性 —— 阶段 1 那段 bash 里的自检是强制的**，发送前跑，非 ASCII 或 BOM 直接拦下。

🚨 **PowerShell 的 `Parser::ParseInput` 抓不到这个 bug** —— 用它做「只解析不执行」的语法校验时，
含 emoji 的脚本照样报 `PARSE-OK`，因为那条路径是在内存里按 UTF-8 解码的。**失败只发生在云助手的
投递路径上**（base64 → 落文件 → PowerShell 按本机编码读）。⇒ 两道检查管的不是同一件事：

| 检查                      | 抓得到                               | 抓不到          |
| ------------------------- | ------------------------------------ | --------------- |
| 发送前 ASCII/BOM 自检     | emoji · BOM · 控制字符               | 语法错误        |
| `Parser::ParseInput` 校验 | 语法错误 · 保留字（如裸 `<占位符>`） | **emoji / BOM** |

**缺一不可。** 2026-08-15 我在修本文件时又写进一个 `🚨`，`PARSE-OK` 照过，是 ASCII 自检拦下的。

> 这条是被真实咬到才发现的：SKILL.md 初版的采集脚本注释里有一个 `⚠️`，第一次真机试跑
> **完全无输出而一切指标显示成功**。同期能跑通的 6 个脚本纯属「碰巧全用英文写」。
>
> 另外注意：`scripts/quantwin-health/probe.sh` 的载荷（`build_ps`）已验证为纯 ASCII，改它时同样适用本条。

### 该机其它已知事实

- **业务数据约 4 GB 且不是元凶**：交易组件落在 `C:\` 根下的行情 / 元数据目录，占整盘约 10%。
- **应用日志约 80 MB/天 ≈ 2.4 GB/月，有审计留存要求不能删**。这是**长期占用的真正驱动**，比 WinSxS 更值得关注 —— WinSxS 是一次性回收，日志是持续流出。
- **`SoftwareDistribution\Download` 的挂起载荷删不掉**：属主 `NT AUTHORITY\SYSTEM` + `NT SERVICE\TrustedInstaller` 持 FullControl；`takeown` 也未必成功（疑似长路径，当天未验证）。余量充裕时**不值得追**。
- **系统盘 40 GB 对 Server 2025 结构性偏小**（WinSxS 本体就 ~7.8 GB + 冗余）。彻底解法是扩容，但需用户在控制台操作（RAM 权限不足）且不可缩容。用户 2026-08-15 明确**选择不扩容**。

---

## 收尾必做

1. **更新私有 runbook** [`stock-quant-win-server.md`](../../../docs/private/runbook/stock-quant-win-server.md)：本次处置的日期 / 前后空间 / 做了什么 / 刻意没做什么。
2. **报一次告警侧一致性**：`bash ~/.nvy/quantwin-health/probe.sh`，确认阈值判定与实际相符。
3. **如果重启过**：确认用户已 RDP 拉起交易系统，并用阶段 5 的四条活性信号验证，不能只看进程数。
