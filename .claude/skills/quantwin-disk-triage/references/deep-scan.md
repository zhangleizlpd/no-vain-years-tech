# 阶段 2 · 深扫归因脚本

只在阶段 1 判定「确实空间不足」后跑。**耗时约 8 分钟**（两次全盘递归 + `AnalyzeComponentStore` 约 150s），
2 核机器上 I/O 偏重 ⇒ **不要在交易时段跑**。用 `run_in_background` 轮询，别前台干等。

## 脚本

```powershell
$ErrorActionPreference='SilentlyContinue'
function DirMB($p){ $b=(Get-ChildItem $p -Recurse -File -Force -EA SilentlyContinue | Measure-Object Length -Sum).Sum; if($null -eq $b){0} else {[math]::Round($b/1MB,1)} }

Write-Output "===== C: TOP-LEVEL (APPARENT size - hardlinks are double-counted!) ====="
Get-ChildItem C:\ -Directory -Force -EA SilentlyContinue | ForEach-Object {
  [pscustomobject]@{ N=$_.Name; MB=(DirMB $_.FullName) } } |
  Sort-Object MB -Descending | Select-Object -First 15 |
  ForEach-Object { Write-Output ("  {0,10:N1} MB  {1}" -f $_.MB,$_.N) }
Write-Output "  ^^ SANITY CHECK: if these sum to MORE than 'used' from fsutil, hardlinks are being"
Write-Output "     double-counted. Do NOT draw conclusions from these numbers until reconciled."

Write-Output "`n===== C:\Windows SUBDIRS (same caveat) ====="
Get-ChildItem C:\Windows -Directory -Force -EA SilentlyContinue | ForEach-Object {
  [pscustomobject]@{ N=$_.Name; MB=(DirMB $_.FullName) } } |
  Sort-Object MB -Descending | Select-Object -First 12 |
  ForEach-Object { Write-Output ("  {0,10:N1} MB  {1}" -f $_.MB,$_.N) }

Write-Output "`n===== BIG SINGLE FILES (>300MB) - these ARE real (per-file size) ====="
Get-ChildItem C:\ -Recurse -File -Force -EA SilentlyContinue |
  Where-Object { $_.Length -gt 300MB } | Sort-Object Length -Descending | Select-Object -First 20 |
  ForEach-Object { Write-Output ("  {0,10:N0} MB  {1}  (mtime {2})" -f ($_.Length/1MB),$_.FullName,$_.LastWriteTime) }

Write-Output "`n===== HARDLINK PROBE on the largest files (mandatory before any size claim) ====="
Get-ChildItem C:\ -Recurse -File -Force -EA SilentlyContinue |
  Where-Object { $_.Length -gt 300MB } | Sort-Object Length -Descending | Select-Object -First 5 |
  ForEach-Object {
    Write-Output ("  [{0:N0} MB] {1}" -f ($_.Length/1MB),$_.FullName)
    fsutil hardlink list $_.FullName 2>&1 | ForEach-Object { Write-Output ("      {0}" -f $_) } }

Write-Output "`n===== COMPONENT STORE - THE authoritative WinSxS number ====="
Dism.exe /Online /Cleanup-Image /AnalyzeComponentStore 2>&1 |
  Where-Object { $_ -notmatch '^\s*\[[=\s%\d\.]+\]\s*$' -and $_.Trim() -ne '' } |
  ForEach-Object { Write-Output ("  {0}" -f $_) }
```

## 怎么读 `AnalyzeComponentStore`

```text
组件存储的实际大小 : 22.24 GB      ← 去过硬链接重复后的真实值
    已与 Windows 共享 : 7.84 GB    ← 就是运行中的系统本体，不是额外占用，动不得
    备份和已禁用的功能 : 14.39 GB  ← 冗余部分，这才是可清理的目标
    缓存和临时数据 : 0 bytes
可回收的程序包数 : 4               ← 只有 /ResetBase 能清，普通清理动不了
推荐使用组件存储清理 : 是
```

**「实际大小」减「已与 Windows 共享」= WinSxS 的净额外占用**，这个数才可以拿去和磁盘容量比。

⚠️ 「备份和已禁用的功能」里混着两类，**DISM 不告诉你比例**：

1. 被取代的旧组件版本 → `/StartComponentCleanup` 能清
2. 已禁用功能的载荷 → 只有 `/RemoveFeature` 能清（清了该功能就不能再启用）

⇒ **不要预告 `/ResetBase` 能回收多少 —— 你不知道。** 2026-08-15 普通清理拿到 5.45 GB 后，
「可回收的程序包数」仍是 4、「推荐清理」仍是「是」，剩余 8.99 GB 的构成依然不透明。

## 日志增长率（长期占用的真正驱动）

从阶段 1 采集到的**进程 path** 推导出用户 profile，再算应用日志目录的增长率：

```powershell
# <LOGDIR> is derived from the ExecutablePath collected in stage 1. Never hardcode it.
Get-ChildItem '<LOGDIR>' -Directory -Force -EA SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 6 | ForEach-Object {
    $b=(Get-ChildItem $_.FullName -Recurse -File -Force -EA SilentlyContinue | Measure-Object Length -Sum).Sum
    $days=[math]::Max(1,($_.LastWriteTime - $_.CreationTime).TotalDays)
    Write-Output ("  {0,9:N1} MB / {1,5:N1} d = {2,6:N1} MB/day   {3}" -f ($b/1MB),$days,($b/1MB/$days),$_.Name) }
```

2026-08-15 实测稳定在 **~80 MB/天 ≈ 2.4 GB/月**。这些日志**有审计留存要求，不能删** ——
把它算进「下次告急还有多久」的预测里，别只看 WinSxS。
