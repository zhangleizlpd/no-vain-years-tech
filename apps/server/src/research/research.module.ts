import { Module } from '@nestjs/common';

/**
 * research — 第 11 个 bounded context（057 研报库；ADR-0065）。
 *
 * PRD §3.8 研报库在 PRD 里与 §3.5 预警管理、§3.6 笔记管理**同级**，而 §3.5 已落成独立
 * ctx `alert` —— 立本 ctx 的依据是这条仓内先例，不是 DDD 论证。另两条硬理由：
 * ① `marketdata.Announcement` 的 `instrumentId` 是必填 FK 且在唯一键内，行业/宏观研报没有
 * 它，那张表结构上不可复用；② marketdata 30 张表共同的不变量是「vendor 采集、可 truncate
 * 后重新 backfill」，研报不可重采，放进去会把「该 schema 能否整体重建」的答案从「能」变成
 * 「不能」。
 *
 * **跨 ctx 面 = 0**：`symbol` 存归一后的 `market:code` 裸字符串，不建到
 * `marketdata.instrument` 的外键、不做存在性校验（校验会拒绝合法新标的，且引入本可避免的
 * Q7-B 依赖）。对齐 014「与 015 运行时零跨 ctx，仅共享 `market:code` 逻辑键」。
 *
 * 依赖方向：research → security（PrismaService / ProblemDetailFilter / GuestUploadAuthGuard）
 * + integrations（对象写入 port）。**禁** account —— guest 面走通道层常量 token、零用户
 * principal，不碰 `JwtAuthGuard`（ESLint boundaries 硬拦，见 `eslint.config.mjs`）。
 *
 * 🚨 **无 server 侧 throttler 桶**，刻意的：本端点只挂 `GuestUploadAuthGuard`、不挂
 * `ThrottlerGuard`（本仓无全局 `APP_GUARD`），且 guest-proxy 与 app 同机、其
 * `proxy_set_header` 组不带 XFF ⇒ server 侧只能按 `req.ip` 计而它恒为 `127.0.0.1`，
 * 一个桶会把两个投递方焊在一起，与 FR-016 / SC-007「单投递方独立限频、不牵连他人」相悖。
 * 限频由通道层 nginx 的 `limit_req_zone`（按 `$guest_name` 分，天然 per-guest）承担。
 * 范式同 `agent-bridge`（同为机器对机器 + 自有 token guard，亦零 throttler 接线）。
 *
 * 本 module 当前是 ctx 的注册锚；controller / usecase / port 绑定在 T009 接入。
 */
@Module({})
export class ResearchModule {}
