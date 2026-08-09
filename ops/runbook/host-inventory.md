# host-inventory（本体已私有化）

本文原是全机队的 **代号 → 公网 IP → ECS 实例 ID → 阿里云账号 UID → VPC/SG ID** 主映射表。仓已公开 → 整篇移出：它的内容本身即情报，不是靠脱敏个别字段就能公开的。

- **本体**：`docs/private/runbook/host-inventory.md`（本机私有，未公开）
- **冻结副本**：私有归档仓 `zhangleizlpd/no-vain-years` @ tag `archive/pre-public-split`
- **判据**：[`docs/conventions/information-boundary.md`](../../docs/conventions/information-boundary.md) §「私有散文」

## 公开侧还剩什么

主机在公开仓里**只以代号出现**（`app` / `index` / `broker-hk` / `quant-win` / `quant-linux`），代号的角色说明与变量契约见 [`ops/host/fleet.env.example`](../host/fleet.env.example)。真实绑定在运行时从仓外解析：

| 消费方               | 解析源               |
| -------------------- | -------------------- |
| dev Mac 脚本         | `~/.nvy/fleet.env`   |
| 主机上的 unit / 脚本 | `/etc/nvy-fleet.env` |
| GitHub Actions       | repo secrets         |

换物理机只改上面这三处，仓内零改动 —— 这是「代号 ↔ 物理绑定解耦」的全部意义。
