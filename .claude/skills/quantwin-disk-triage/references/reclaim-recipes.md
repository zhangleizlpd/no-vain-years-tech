# 阶段 4 · 分级回收配方

> **进入本文件即意味着即将做破坏性操作。** SKILL.md 的三道无条件闸在这里全部生效：
> 每一档动手前，列出「做什么 · 预估回收 · 风险 · 是否会回涨」，停下等用户逐项确认。

## 排序纪律

**先零风险小项腾余量，再动 DISM。** `StartComponentCleanup` 自身需要可用空间才能跑；
在几十 MB 的盘上直接跑大概率失败，而 DISM 中途失败可能让组件存储进入不一致状态 ——
这在实盘机上是最不能接受的失败模式。

```text
A 档（不需重启，零风险）  →  B 档（需重启）  →  C 档（DISM 保守）  →  D 档（DISM /ResetBase）
                                                                        ↑ 默认不做
```

---

## A 档 · 零风险，不需重启

### A1 · Windows Update 下载缓存

通常是最大的一块「白捡」空间，且在盘满场景下里面往往正是**反复下载失败的残留**。

```powershell
Stop-Service wuauserv -Force -EA SilentlyContinue
Stop-Service bits     -Force -EA SilentlyContinue
Start-Sleep -Seconds 3
Remove-Item 'C:\Windows\SoftwareDistribution\Download\*' -Recurse -Force -EA SilentlyContinue
# Whatever survives = staged payload of a pending servicing transaction (TiWorker holds
# the handle). That part belongs to tier B, not here.
```

⚠️ **只清 `Download\`，别动 `DataStore\`**（那是更新历史，删了就查不到装过什么）。

⚠️ 清完**先别把 `wuauserv` 起回来** —— 否则刚腾的空间可能立刻被重新下载吃掉。但这只是权宜；
真正的护栏是先确认 `NoAutoUpdate=1`（见 A3）。

### A2 · 其它标准桶

`C:\Windows\Temp` / `C:\Windows\Prefetch` / `C:\$Recycle.Bin` / `C:\Windows\Minidump`。

⚠️ 2026-08-15 实测这几个**全是 0** —— 别指望。先看阶段 1 的实测值再决定要不要动。

### A3 · 关掉自动更新（**不是回收空间，是防引爆**）

腾出空间会让已挂起的更新立刻装上并要求重启。这台机曾被设成 `AUOptions=4` +
`ScheduledInstallDay=0` + `ScheduledInstallTime=3` —— **每天凌晨 3 点自动装更新并重启**。
如果在交易时段触发，那就是事故。

```powershell
$au='HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU'
# Print the existing values first (rollback reference), then change them.
if(-not (Test-Path $au)){ New-Item -Path $au -Force | Out-Null }
New-ItemProperty -Path $au -Name NoAutoUpdate -Value 1 -PropertyType DWord -Force | Out-Null
New-ItemProperty -Path $au -Name AUOptions    -Value 2 -PropertyType DWord -Force | Out-Null
```

`NoAutoUpdate=1` 后仍可手动检查/安装更新。`UseWUServer=1` 指向阿里云自家更新镜像，是云上
Windows 镜像的标配，**不用动**。

---

## B 档 · 需要重启才能拿到

`CBS.log`（盘满场景下常涨到数百 MB）与 `Download` 的挂起载荷，句柄被 `TiWorker` 持有。

**先试干净停服务**（`sc.exe stop TrustedInstaller` + 轮询最多 120s）。停下来了就能删；
**停不下来就放弃这一档并如实报告** —— ❌ **永不 `Stop-Process -Force TiWorker`**。

停不下来时，`RebootPending` 基本就是原因 ⇒ **过闸 2**，把重启这个决定交给用户。

### 重启配方（仅在用户明确同意后）

```powershell
shutdown /r /t 90 /c "Planned maintenance: disk cleanup"
```

- **刻意不加 `/f`** —— 让 Electron 应用收到 `WM_QUERYENDSESSION` 干净退出，给它的嵌入式 KV
  存储一个正常 flush 的机会，而不是硬杀后靠 value-log 重放恢复。
- 2026-08-15 实测：**停机仅约 5 秒**（云主机热重启），`PackagesPending=False` 时不会经历漫长的
  「正在配置 Windows 更新」。
- ⚠️ **不要用云助手心跳判断机器有没有重启** —— 当天心跳间隔只从 ~55s 拉长到 83s，我据此误判
  「没有重启」。**权威判据是 `LastBootUpTime`**，或系统日志 `Kernel-General` id=12/13 + `Kernel-Power` id=109。
- ⚠️ 现有 RAM 权限**没有** `ecs:RebootInstance` ⇒ 优雅重启若被卡住，**你强制不了**，只能让用户去控制台。事前要讲清楚。

### 重启后立刻做

1. 删 `CBS.log` —— 注意它可能已在重启时**轮转**成 `CbsPersist_<ts>.log`，两个都要处理。
2. 清 `Download` 残余。
3. 复查挂起状态是否已清（`RebootPending` / `PendingFileRename` / `PackagesPending`）。
4. **交易系统一定是停的** —— 用阶段 1 采集到的 `ExecutablePath` 告诉用户去 RDP 拉起。

重启本身往往还会顺带释放可观空间（AppX 延迟回收 + 注册表 hive 压缩 + `PendingFileRename` 执行）——
2026-08-15 这一项就有约 1 GB。

---

## C 档 · DISM 组件存储清理（保守档，**默认选它**）

**前置**（不满足就别跑）：`RebootPending=False` · `PackagesPending=False` · 有几个 GB 可用空间。

```powershell
Dism.exe /Online /Cleanup-Image /StartComponentCleanup
```

- 2026-08-15 实测：**8 分 18 秒，回收 5.45 GB**（组件存储 22.24 → 16.79 GB）。
- **零能力损失**：当前版本一个没动，已装更新**仍可单独卸载**。
- 唯一理论代价：`sfc /scannow` / `DISM /RestoreHealth` 若要恢复某个已删的旧版本组件，需要联网或 `/Source`。实际极少发生。
- ⚠️ I/O 重 ⇒ **不要在交易时段跑**。

跑完**必须**再跑一次 `AnalyzeComponentStore`，与阶段 2 同口径对比，把真实回收量报出来。

---

## D 档 · `/ResetBase` —— 默认不做

```powershell
Dism.exe /Online /Cleanup-Image /StartComponentCleanup /ResetBase
```

**代价是确定的、不可逆的**：所有已装更新变为**永久不可卸载**（「已安装的更新」列表清空）。

**收益是未知的** —— DISM 不拆分「被取代的包」与「已禁用功能载荷」的比例。

对实盘机而言，「某个 Windows 更新装完后交易软件行为异常，但你没法单独回滚那个更新」是很难受的处境。
**用未知收益换确定的能力损失，不划算。** 2026-08-15 用户已明确不做。

要做的话，闸 3 必须额外讲清上面这段。

---

## E 档 · 边际项（实测收益远低于表观，通常不值得）

| 项                  | 表观   | 实测                     | 结论                                                                                                         |
| ------------------- | ------ | ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Defender 特征库     | 869 MB | **−101 MB** 且会重新下回 | `Backup` + 出厂基线 + 当前，设计如此。**净收益≈0，别做**                                                     |
| 旧版 AppX           | 370 MB | **−0 MB**（延迟到重启）  | `Remove-AppxPackage` 只取消注册。顺手做可以，别计入预估                                                      |
| Edge / WebView2     | 3.1 GB | **约 850 MB**            | 四目录互为硬链接。收益缩水 3.6 倍后不值得冒险                                                                |
| `winre.wim`         | 762 MB | 762 MB                   | `reagentc /disable` 只是**移动**到 `System32\Recovery`，还要手动删才腾出空间；代价是失去 WinRE。没快照时别做 |
| `Download` 挂起载荷 | 365 MB | 删不掉                   | 属主 SYSTEM + TrustedInstaller FullControl，`takeown` 也未必成功（疑似长路径）。余量充裕时不值得追           |

**报预估时的纪律**：先问「它会不会回涨」「是不是延迟释放」「表观值有没有被硬链接放大」。
三个问题里任何一个答不上来 —— **说不知道，别编数字**。

---

## 结构性方案（不属于「清理」，但每次都该提一句）

系统盘 40 GB 对 Windows Server 2025 结构性偏小（WinSxS 本体就约 7.8 GB）。清理只是把问题推后数月：

```text
可用空间 ÷ (应用日志 ~2.4 GB/月 + 累积更新 ~1–2 GB/月) ≈ 还能撑几个月
```

彻底解法是**扩容系统盘**，但：需用户在控制台操作（RAM 权限不足）· 包年包月实例属升配要花钱 ·
**不可缩容**。2026-08-15 用户明确选择不扩容 —— 每次处置时给出上面那个算式的当期值即可，不必反复劝。
