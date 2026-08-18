# Changelog

<!-- release-please 在 `# Changelog` 之后 prepend 新版本条目；下面这段说明会一直沉在末尾。 -->

## [0.30.0](https://github.com/zhangleizlpd/no-vain-years-tech/compare/server-v0.29.0...server-v0.30.0) (2026-08-18)


### Features

* **core:** 行情时点语义收口三处 —— 建锚即有价 / 手动补采时点闸 / hk 时段单段化 ([#95](https://github.com/zhangleizlpd/no-vain-years-tech/issues/95)) ([bfcf1e6](https://github.com/zhangleizlpd/no-vain-years-tech/commit/bfcf1e6585f1118e7acfc45e7b8219a9cd5ce8bd))
* **marketdata:** 061 行情实时面 + 美股正股盘中价接入期权台雷达 ([#92](https://github.com/zhangleizlpd/no-vain-years-tech/issues/92)) ([9069d3f](https://github.com/zhangleizlpd/no-vain-years-tech/commit/9069d3f0af6dcd8ac86667f93f640cad61f79cbb))

## [0.29.0](https://github.com/zhangleizlpd/no-vain-years-tech/compare/server-v0.28.1...server-v0.29.0) (2026-08-18)


### Features

* **marketdata:** 060 锚首建冷启动补数 —— 建锚即补最近一场收盘的链 / 快照 / 日线 ([#89](https://github.com/zhangleizlpd/no-vain-years-tech/issues/89)) ([cd010f2](https://github.com/zhangleizlpd/no-vain-years-tech/commit/cd010f2b450f38bcb45fd1005ec65022c811b68f))

## [0.28.1](https://github.com/zhangleizlpd/no-vain-years-tech/compare/server-v0.28.0...server-v0.28.1) (2026-08-17)


### Bug Fixes

* **optionsdesk:** 锚 close 投影改每小时 —— 固定时点绑不住按市场分裂的上游 ([#85](https://github.com/zhangleizlpd/no-vain-years-tech/issues/85)) ([88ff4d3](https://github.com/zhangleizlpd/no-vain-years-tech/commit/88ff4d3d653743b9d562319f0338cd917cbe001e))

## [0.28.0](https://github.com/zhangleizlpd/no-vain-years-tech/compare/server-v0.27.0...server-v0.28.0) (2026-08-17)


### Features

* **optionsdesk:** 059 锚的模型导入通道 —— 隧道内直写 + 他人待审收件箱 ([#81](https://github.com/zhangleizlpd/no-vain-years-tech/issues/81)) ([967e209](https://github.com/zhangleizlpd/no-vain-years-tech/commit/967e2099c53db449a9df0e19ba932d9b9dbb769e))


### Bug Fixes

* **research:** 503 补 code，能力目录 8 条漂移归零 ([#78](https://github.com/zhangleizlpd/no-vain-years-tech/issues/78)) ([9e7b2d6](https://github.com/zhangleizlpd/no-vain-years-tech/commit/9e7b2d6e3d2634b7e259ed9284ec3976c2bc6256))

## [0.27.0](https://github.com/zhangleizlpd/no-vain-years-tech/compare/server-v0.26.1...server-v0.27.0) (2026-08-16)


### Features

* **research:** 058 研报归档同标的多版本与元数据回声 ([#76](https://github.com/zhangleizlpd/no-vain-years-tech/issues/76)) ([0a1feda](https://github.com/zhangleizlpd/no-vain-years-tech/commit/0a1feda42449e75b832fda1d49e314264306be8e))


### Bug Fixes

* **marketdata:** 期权完整性探针加 ET 周末闸 —— 周六周日 us 不开盘,判它就是每周两条固定假红 ([#73](https://github.com/zhangleizlpd/no-vain-years-tech/issues/73)) ([8cb5be3](https://github.com/zhangleizlpd/no-vain-years-tech/commit/8cb5be34fbaa8e1c58635a94fb2f0267a0b22133))
* **server:** vitest 补 testTimeout 默认值 —— 24 条串行打真栈的 it 一直吃 5s 默认值,满载即假红 ([#77](https://github.com/zhangleizlpd/no-vain-years-tech/issues/77)) ([a4100bc](https://github.com/zhangleizlpd/no-vain-years-tech/commit/a4100bc1d0c832b238b531dfc1dac187aab4f9cb))

## [0.26.1](https://github.com/zhangleizlpd/no-vain-years-tech/compare/server-v0.26.0...server-v0.26.1) (2026-08-16)


### Bug Fixes

* **core:** 图片对象存储迁往账号 C —— 账号 B 的 OSS 欠费停服,顺带结掉「存绝对 URL」的老账 ([#66](https://github.com/zhangleizlpd/no-vain-years-tech/issues/66)) ([b08e4c4](https://github.com/zhangleizlpd/no-vain-years-tech/commit/b08e4c4a5835eaf2741a722de0e826446dff8746))

## [0.26.0](https://github.com/zhangleizlpd/no-vain-years-tech/compare/server-v0.25.0...server-v0.26.0) (2026-08-15)


### Features

* **research:** 研报库 guest 投递入口 —— 第 11 个 bounded context + 私有桶只写归档 ([#59](https://github.com/zhangleizlpd/no-vain-years-tech/issues/59)) ([5b46e2b](https://github.com/zhangleizlpd/no-vain-years-tech/commit/5b46e2b0c3d05e1c28795d2d0d7b9c52146c01a4))


### Bug Fixes

* **marketdata:** 昨收读侧补官方反推 —— 理杏仁不下发 prevClose,详情/日K 直透 stored 列致恒 '--' ([#56](https://github.com/zhangleizlpd/no-vain-years-tech/issues/56)) ([dfb50c2](https://github.com/zhangleizlpd/no-vain-years-tech/commit/dfb50c2a19f5075e5ce5068e1a069865f32f72b0))
* **security:** 开 trustProxy 取真实客户端 IP —— prod 恒在 nginx 后,socket 地址是私网致 IP 全丢 ([#57](https://github.com/zhangleizlpd/no-vain-years-tech/issues/57)) ([9252678](https://github.com/zhangleizlpd/no-vain-years-tech/commit/92526781e6377950074dc65633d7b74cd849eceb))

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
