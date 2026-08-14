# Changelog

<!-- release-please 在 `# Changelog` 之后 prepend 新版本条目；下面这段说明会一直沉在末尾。 -->

## [0.25.0](https://github.com/zhangleizlpd/no-vain-years-tech/compare/server-v0.24.0...server-v0.25.0) (2026-08-14)


### Features

* **marketdata:** 054 mock 下 28 个采集口拒绝写库 + provider 非法值 boot 抛 ([#39](https://github.com/zhangleizlpd/no-vain-years-tech/issues/39)) ([b2455da](https://github.com/zhangleizlpd/no-vain-years-tech/commit/b2455daf507890522aa5a5cb44c853f853a3dbc9))
* **optionsdesk:** 052 选约检索分层落地 + 三视角逐层判据重梳 ([#34](https://github.com/zhangleizlpd/no-vain-years-tech/issues/34)) ([90e8b74](https://github.com/zhangleizlpd/no-vain-years-tech/commit/90e8b743bf76cce65d1f7eef51ddd1ae827f84e9))
* **optionsdesk:** 053 选约表查询下沉 —— 每视角独立请求 + 响应收窄 + 表达层截断 ([#41](https://github.com/zhangleizlpd/no-vain-years-tech/issues/41)) ([b17b4d6](https://github.com/zhangleizlpd/no-vain-years-tech/commit/b17b4d6d8cc9d73278ce6b4705d448f769ab8676))
* **optionsdesk:** 055 标的链分析报表 —— 打开选约表之前先看清整条链的机会分布 ([#46](https://github.com/zhangleizlpd/no-vain-years-tech/issues/46)) ([0312c0f](https://github.com/zhangleizlpd/no-vain-years-tech/commit/0312c0f0b3af365d8d39e2a8f4eb52afbb92d0ff))


### Bug Fixes

* **optionsdesk:** 月度链标换源到 vendor 到期周期 —— 交易日历结构上给不出未来交易日 ([#48](https://github.com/zhangleizlpd/no-vain-years-tech/issues/48)) ([b4197d6](https://github.com/zhangleizlpd/no-vain-years-tech/commit/b4197d61c9f7d425eeeaf813260d5862f5ff86be)), closes [#45](https://github.com/zhangleizlpd/no-vain-years-tech/issues/45)

## [0.24.0](https://github.com/zhangleizlpd/no-vain-years-tech/compare/server-v0.23.2...server-v0.24.0) (2026-08-12)


### Features

* **optionsdesk:** 050 选约引擎 server 三层重构 —— 召回 / 打标 / 精排 ([#23](https://github.com/zhangleizlpd/no-vain-years-tech/issues/23)) ([fc3b7e9](https://github.com/zhangleizlpd/no-vain-years-tech/commit/fc3b7e9aeee1b6e8548cbd024ef95a00e29ac249))
* **optionsdesk:** 051 选约表显示口径跟进 —— 七块契约消费 + 按视角拆的排除计数 ([#29](https://github.com/zhangleizlpd/no-vain-years-tech/issues/29)) ([0d6e531](https://github.com/zhangleizlpd/no-vain-years-tech/commit/0d6e53145d28b84473df65cec63d393346d3dc64))
* **optionsdesk:** 选约表补挂牌量 + 价格统一 2 位 —— 顺带把横滑自激环定案成 ADR-0063 ([#18](https://github.com/zhangleizlpd/no-vain-years-tech/issues/18)) ([6686756](https://github.com/zhangleizlpd/no-vain-years-tech/commit/66867567d288b1433309e2d7c9e3dc8f96a79bda))


### Bug Fixes

* **marketdata:** B 股币种按 code 判, 不是 cn 就 CNY —— 派息被守卫吞掉, 整段历史静默不复权 ([#28](https://github.com/zhangleizlpd/no-vain-years-tech/issues/28)) ([8d7e86b](https://github.com/zhangleizlpd/no-vain-years-tech/commit/8d7e86b36d348d6c9b4c1a7a6c1ff618e81de5e4))
* **marketdata:** eod delta 补洞道 —— 当晚 vendor 没出数的那批, 此前永远没有第二次机会 ([#30](https://github.com/zhangleizlpd/no-vain-years-tech/issues/30)) ([611b3c1](https://github.com/zhangleizlpd/no-vain-years-tech/commit/611b3c1abae844add700391b7142441bdf563a95))
* **marketdata:** 补上 429 与耗时两条取证通道 —— 一次限频在两侧都静默, 一轮跑多久表里读不出 ([#14](https://github.com/zhangleizlpd/no-vain-years-tech/issues/14)) ([119093c](https://github.com/zhangleizlpd/no-vain-years-tech/commit/119093cf18b54a8eb2e4fcf4789fe0386c3f9108))

## [0.23.2](https://github.com/zhangleizlpd/no-vain-years-tech/compare/server-v0.23.1...server-v0.23.2) (2026-08-09)


### Bug Fixes

* **marketdata:** 429 移出熔断计数 —— 背压被当成故障, 一次纯限频被记成标的 failed ([#13](https://github.com/zhangleizlpd/no-vain-years-tech/issues/13)) ([95c334e](https://github.com/zhangleizlpd/no-vain-years-tech/commit/95c334ece05031f91a38f02a1ee94f1f0dac7ca2))
* **marketdata:** 限频档按上游真实窗形声明 —— 富途链发现每 30 分钟原地打转、12 只锚只采到前 2 只 ([#9](https://github.com/zhangleizlpd/no-vain-years-tech/issues/9)) ([3981e3e](https://github.com/zhangleizlpd/no-vain-years-tech/commit/3981e3e6fd55e93f0ff1025a7ac02799a9e6ccb2))
* **repo:** typecheck 改走 noEmit 入口 —— 从「.d.ts 的第二个生产者」降级为纯读者 ([#12](https://github.com/zhangleizlpd/no-vain-years-tech/issues/12)) ([e5ec2fb](https://github.com/zhangleizlpd/no-vain-years-tech/commit/e5ec2fbdf9622de6ecb6a00a566d6c8c84f0ebad))
* **repo:** 补上 runtime-smoke 的定序 —— CI 上 TS7006 随机报在无关文件的最后一条路 ([#11](https://github.com/zhangleizlpd/no-vain-years-tech/issues/11)) ([dbf56b2](https://github.com/zhangleizlpd/no-vain-years-tech/commit/dbf56b2917744f2db768cf580c761882f2eb1159))

## [0.23.1](https://github.com/zhangleizlpd/no-vain-years-tech/compare/server-v0.23.0...server-v0.23.1) (2026-08-09)


### Bug Fixes

* **account:** 对象探测把「查不出来」当成「对象不在」—— 对上传成功的用户说谎 ([#5](https://github.com/zhangleizlpd/no-vain-years-tech/issues/5)) ([fabe6cb](https://github.com/zhangleizlpd/no-vain-years-tech/commit/fabe6cbcbffb65d2c43311d8ae7b8d20cf639c78))

## 0.23.0 之前的历史

本仓转公开时截断（2026-08-08）。逐版本条目、PR 链接与作者署名完整保留在**私有归档仓**
`zhangleizlpd/no-vain-years` @ tag `archive/pre-public-split`。

截断而非保留的理由：release-please 生成的每条条目都带 PR / commit 超链，而那些链接指向
迁移前的仓库路径 —— 现已全部失效，且把仓库标识写进了一份逐行重复上百次的文件里
（per [`docs/conventions/information-boundary.md`](../../docs/conventions/information-boundary.md)）。

版本号的单一来源是 `.release-please-manifest.server.json`，不依赖本文件 —— 截断不影响 release-please 续算下一版。
截断时版本：**0.23.0**。
