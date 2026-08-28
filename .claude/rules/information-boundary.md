---
paths:
  - 'ops/**'
  - 'services/**/deploy/**'
  - 'services/**/*.conf.example'
  - '.github/workflows/**'
  - 'docs/private/**'
  - 'scripts/checks/check-identifier-boundary.ts'
  - 'scripts/*/setup.sh'
  - 'scripts/*/sync.sh'
  - 'docs/improvements/**'
  - '**/docker-compose*.yml'
---

# 信息边界（path-triggered，触及主机配置 / 部署链 / 私有散文时自动加载）

**本仓面向公开。** 你现在动的文件属于最容易写进真实标识符的那一类。

## 硬红线

**永不**把下列内容写进 tracked 文件、commit message、PR body、spec / plan：

公网 IP · `user@host` 串 · ECS/云主机实例 ID · 云账号 UID · VPC / vSwitch / 安全组 ID · 容器镜像仓实例 ID · CDN / DNS 账号 ID · operator 的家庭或办公出口 IP · 宿主机上**凭据文件**的确切路径

**反过来这三类留公开**（初版划错过）：ssh-config alias、主机上的**仓**路径、公开构建服务的 project ID（Expo / EAS）。判据：泄漏它是否降低攻击成本 + 它能不能被 env 化，两个都「否」就别塞进仓外层 —— 假阳性会让整层守门失去可信度（为什么 → canonical § 三条容易判错的边界）。

**改为**：仓内只用**角色代号**；真值在 `ops/host/fleet.env.example` 声明变量名，运行时从 `~/.nvy/fleet.env`（dev 机）/ `/etc/nvy-fleet.env`（主机）/ GitHub Actions repo secrets 解析。

## 三个不直觉的判定

1. **RFC1918 地址（`10.x` / `172.16-31.x` / `192.168.x`）留公开** —— 没有 VPN 公钥且没有公网 endpoint 时它是惰性的，而 endpoint 已出仓。只参数化 `Endpoint = <公网IP>:<port>`。
2. **内容本身即情报的整篇出仓，别逐字段脱敏** —— 主机清单、RAM 用户↔权限↔凭据路径映射、实盘系统脆弱窗口、自然人位置。归 `docs/private/`，公开侧按需留 stub 保入链。
3. **限频值 / CORS 白名单 / 反枚举逻辑留公开** —— 依赖细节不被知道的防护本来就不安全。

## 写之前问自己

- 这里面有没有能定位到一台真机或一个云账号的字符串？
- 只脱掉那些字符串，剩下的还安全吗？不安全 → 整篇进 `docs/private/`。
- 我写的是**状态**（进 plan）还是**判据**（进 convention）？

## 别把 gitleaks 绿当证据

gitleaks 靠熵与厂商前缀识别凭据，**抓不到裸 IP / 云账号 UID / 实例 ID**。标识符那一层是 `scripts/checks/check-identifier-boundary.ts`（CI 无条件跑 + pre-commit + commit-msg）。

> canonical：[`docs/conventions/information-boundary.md`](../../docs/conventions/information-boundary.md)（三层归属决策表 + 代号纪律 + 5 问自检 + 验证纪律「反例存在我能看到吗」）。
