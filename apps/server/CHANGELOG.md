# Changelog

<!-- release-please 在 `# Changelog` 之后 prepend 新版本条目；下面这段说明会一直沉在末尾。 -->

## [0.36.3](https://github.com/zhangleizlpd/no-vain-years-tech/compare/server-v0.36.2...server-v0.36.3) (2026-08-25)


### Bug Fixes

* **marketdata:** 066 T09 oi_as_of 按市场分叉 —— 港股收盘当晚定稿, 重标已采的 523 行 ([#191](https://github.com/zhangleizlpd/no-vain-years-tech/issues/191)) ([80d5873](https://github.com/zhangleizlpd/no-vain-years-tech/commit/80d58734f71b780075374745aa0cb00ea5c808f3))

## [0.36.2](https://github.com/zhangleizlpd/no-vain-years-tech/compare/server-v0.36.1...server-v0.36.2) (2026-08-25)


### Bug Fixes

* **marketdata:** [#179](https://github.com/zhangleizlpd/no-vain-years-tech/issues/179) vendor 按词根串市场 —— 链 adapter 丢跨市场行, us:ALB 恢复采集 ([#185](https://github.com/zhangleizlpd/no-vain-years-tech/issues/185)) ([7b7cc55](https://github.com/zhangleizlpd/no-vain-years-tech/commit/7b7cc553867192419a8244d51c0f025c273cd2de))
* **marketdata:** 快照归属跟「哪一场收了」走, 不跟日历日走 —— 判据 + 盘中闸合一 ([#181](https://github.com/zhangleizlpd/no-vain-years-tech/issues/181)) ([#183](https://github.com/zhangleizlpd/no-vain-years-tech/issues/183)) ([a91e1a2](https://github.com/zhangleizlpd/no-vain-years-tech/commit/a91e1a2d56a67ceb41f857a8bab2304772348efa))

## [0.36.1](https://github.com/zhangleizlpd/no-vain-years-tech/compare/server-v0.36.0...server-v0.36.1) (2026-08-24)


### Bug Fixes

* **marketdata:** 回改已入库的盘口哨兵 —— 38966 行 (price,size) 成对为 0 落 NULL ([#172](https://github.com/zhangleizlpd/no-vain-years-tech/issues/172)) ([#178](https://github.com/zhangleizlpd/no-vain-years-tech/issues/178)) ([b39c8fa](https://github.com/zhangleizlpd/no-vain-years-tech/commit/b39c8fa138c9f51520a3586aaa3d7940502781dc))
* **marketdata:** 无挂牌期权不再抬 WARN —— 下层就地分岔, 与冷启动层同一定性 ([#173](https://github.com/zhangleizlpd/no-vain-years-tech/issues/173)) ([#174](https://github.com/zhangleizlpd/no-vain-years-tech/issues/174)) ([f91ca92](https://github.com/zhangleizlpd/no-vain-years-tech/commit/f91ca92b77dfc0dada08f8dd398fe104fbe9daeb))
* **marketdata:** 盘口带内哨兵在 adapter 边界归一为 null —— 成对判据 + 破裂报警 ([#172](https://github.com/zhangleizlpd/no-vain-years-tech/issues/172)) ([#177](https://github.com/zhangleizlpd/no-vain-years-tech/issues/177)) ([f85bcc2](https://github.com/zhangleizlpd/no-vain-years-tech/commit/f85bcc2093a52da71c666a8e366d18dcce369b72))

## [0.36.0](https://github.com/zhangleizlpd/no-vain-years-tech/compare/server-v0.35.3...server-v0.36.0) (2026-08-23)


### Features

* **marketdata:** 066 港股期权接入与锚冷启动开通港股 ([#169](https://github.com/zhangleizlpd/no-vain-years-tech/issues/169)) ([ea74b5f](https://github.com/zhangleizlpd/no-vain-years-tech/commit/ea74b5fa4975957d2a5dbc9888c74a9e3c9ce908))

## [0.35.3](https://github.com/zhangleizlpd/no-vain-years-tech/compare/server-v0.35.2...server-v0.35.3) (2026-08-23)


### Bug Fixes

* **marketdata:** sync_run 被部署打断的行收敛为 interrupted —— running 恢复信息量 ([#165](https://github.com/zhangleizlpd/no-vain-years-tech/issues/165)) ([536fef9](https://github.com/zhangleizlpd/no-vain-years-tech/commit/536fef9e5378e738f8bd448ef355c6d7c622e28b))

## [0.35.2](https://github.com/zhangleizlpd/no-vain-years-tech/compare/server-v0.35.1...server-v0.35.2) (2026-08-23)


### Bug Fixes

* **marketdata:** 建锚冷启动不再触发全域重扫 —— 单锚 vendor 外呼 872 → 约 14 次 ([#162](https://github.com/zhangleizlpd/no-vain-years-tech/issues/162)) ([ea251cd](https://github.com/zhangleizlpd/no-vain-years-tech/commit/ea251cd7c44f4a2d98660c8743d4f26c74989818)), closes [#159](https://github.com/zhangleizlpd/no-vain-years-tech/issues/159)

## [0.35.1](https://github.com/zhangleizlpd/no-vain-years-tech/compare/server-v0.35.0...server-v0.35.1) (2026-08-22)


### Bug Fixes

* **repo:** 标的查询口的体量数字全部错了 —— 改成隔通道实测值 ([#154](https://github.com/zhangleizlpd/no-vain-years-tech/issues/154)) ([cb1a978](https://github.com/zhangleizlpd/no-vain-years-tech/commit/cb1a97808a66ec6d6f0bdee10a2225eaa5b3e60a))

## [0.35.0](https://github.com/zhangleizlpd/no-vain-years-tech/compare/server-v0.34.0...server-v0.35.0) (2026-08-22)


### Features

* **marketdata:** guest 通道标的查询 —— 枚举 + 批量基础信息(server 侧) ([#151](https://github.com/zhangleizlpd/no-vain-years-tech/issues/151)) ([7bfe1cc](https://github.com/zhangleizlpd/no-vain-years-tech/commit/7bfe1cc076197d232262ed8896736482eface65e))
* **optionsdesk:** 065 T03 anchor.market 收紧 NOT NULL + 值域 CHECK ([#149](https://github.com/zhangleizlpd/no-vain-years-tech/issues/149)) ([56d247f](https://github.com/zhangleizlpd/no-vain-years-tech/commit/56d247fb1c9725bde7784eb90b820a80707cee50))


### Bug Fixes

* **server:** IT globalSetup 的 migrate 失败原因不再被吞掉 ([#152](https://github.com/zhangleizlpd/no-vain-years-tech/issues/152)) ([e6d92af](https://github.com/zhangleizlpd/no-vain-years-tech/commit/e6d92afe13c2047afa06943bebfbe299a9ae0720))

## [0.34.0](https://github.com/zhangleizlpd/no-vain-years-tech/compare/server-v0.33.2...server-v0.34.0) (2026-08-22)


### Features

* **optionsdesk:** 065 雷达按市场分页签 —— 美股 / 港股 ([#118](https://github.com/zhangleizlpd/no-vain-years-tech/issues/118)) ([214a3a5](https://github.com/zhangleizlpd/no-vain-years-tech/commit/214a3a50e78625d83e29d2adc9ecab6a7b161fb7))


### Bug Fixes

* **marketdata:** [#138](https://github.com/zhangleizlpd/no-vain-years-tech/issues/138) 族一 —— 7 个逐行 upsert 的维度从不上报 written ([#142](https://github.com/zhangleizlpd/no-vain-years-tech/issues/142)) ([26b7231](https://github.com/zhangleizlpd/no-vain-years-tech/commit/26b7231f9c3198282dcf6b312c9ca999bc52e603))
* **marketdata:** [#138](https://github.com/zhangleizlpd/no-vain-years-tech/issues/138) 族二 —— 21 处写路径埋在空转分支内, 空转一轮报 NULL ([#145](https://github.com/zhangleizlpd/no-vain-years-tech/issues/145)) ([32e4a3c](https://github.com/zhangleizlpd/no-vain-years-tech/commit/32e4a3c7a3888049f8ce2a999e27306cc38e79eb))

## [0.33.2](https://github.com/zhangleizlpd/no-vain-years-tech/compare/server-v0.33.1...server-v0.33.2) (2026-08-21)


### Bug Fixes

* **marketdata:** [#103](https://github.com/zhangleizlpd/no-vain-years-tech/issues/103) mergeStats 漏搬 written —— 落库侧计数在生产上恒 NULL ([#136](https://github.com/zhangleizlpd/no-vain-years-tech/issues/136)) ([f7e823d](https://github.com/zhangleizlpd/no-vain-years-tech/commit/f7e823d47c87f8169eb9f3efaa7cc965eab5e79e))
* **optionsdesk:** chain-report 的陈旧度基准吃真实时钟 —— 与同响应其余日期分叉 ([#134](https://github.com/zhangleizlpd/no-vain-years-tech/issues/134)) ([eee4b95](https://github.com/zhangleizlpd/no-vain-years-tech/commit/eee4b95a5f4f85f936fa4ab0e423a1e4d3b4aefb))

## [0.33.1](https://github.com/zhangleizlpd/no-vain-years-tech/compare/server-v0.33.0...server-v0.33.1) (2026-08-19)


### Bug Fixes

* **core:** 064 收尾 —— market-state 限频修复 + 档位条文案与去重 + 窗内数回写 ([#126](https://github.com/zhangleizlpd/no-vain-years-tech/issues/126)) ([70765c5](https://github.com/zhangleizlpd/no-vain-years-tech/commit/70765c533ca1cfa5581f3bff5a67b33565fd17e9))
* **optionsdesk:** 实时覆盖漏了 greeksComplete —— 标与它描述的两格分了家 ([#122](https://github.com/zhangleizlpd/no-vain-years-tech/issues/122)) ([dceca84](https://github.com/zhangleizlpd/no-vain-years-tech/commit/dceca845453ff897d5000fe74f10019fdfac0d33))
* **optionsdesk:** 盘中新锚看不到期权腿 —— 检索层加「实时独载基线」 ([#124](https://github.com/zhangleizlpd/no-vain-years-tech/issues/124)) ([068e436](https://github.com/zhangleizlpd/no-vain-years-tech/commit/068e436c0eabdcc33451cfe5f8147e84a519bd86))

## [0.33.0](https://github.com/zhangleizlpd/no-vain-years-tech/compare/server-v0.32.0...server-v0.33.0) (2026-08-19)


### Features

* **optionsdesk:** 064 美股期权腿盘中实时报价 ([#119](https://github.com/zhangleizlpd/no-vain-years-tech/issues/119)) ([38216ae](https://github.com/zhangleizlpd/no-vain-years-tech/commit/38216aed67882a0da833a0457f66475777b12b71))

## [0.32.0](https://github.com/zhangleizlpd/no-vain-years-tech/compare/server-v0.31.2...server-v0.32.0) (2026-08-19)


### Features

* **marketdata:** 063 Phase 2a —— trading_day 记「这一场开整天还是半天」 ([#114](https://github.com/zhangleizlpd/no-vain-years-tech/issues/114)) ([a00a655](https://github.com/zhangleizlpd/no-vain-years-tech/commit/a00a65580a04d78c7da8b7271ff2e5b4c2531c4f))
* **marketdata:** 063 Phase 2b —— 半日市收盘时刻真正生效 ([#115](https://github.com/zhangleizlpd/no-vain-years-tech/issues/115)) ([c342bab](https://github.com/zhangleizlpd/no-vain-years-tech/commit/c342babb28fcd2f2c32af46e57d01b9951896255))
* **marketdata:** 063 时间语义 Phase 3 —— daily_bar 尾窗可订正 + sync_run 记真正落库行数 ([#111](https://github.com/zhangleizlpd/no-vain-years-tech/issues/111)) ([9a5c0a0](https://github.com/zhangleizlpd/no-vain-years-tech/commit/9a5c0a0a98dbbc3f41ec287d809e392fec4a4303))
* **optionsdesk:** 063 Phase 3.4 —— anchor 留 vendor 自报的「这个价是什么时候的」 ([#113](https://github.com/zhangleizlpd/no-vain-years-tech/issues/113)) ([d114e19](https://github.com/zhangleizlpd/no-vain-years-tech/commit/d114e19945f4ca55b6404c5950159025c6e1a808))

## [0.31.2](https://github.com/zhangleizlpd/no-vain-years-tech/compare/server-v0.31.1...server-v0.31.2) (2026-08-19)


### Bug Fixes

* **marketdata:** 063 时间语义 Phase 1 —— 采集业务日收口到「已收盘 session」+ 词表统一 ([#107](https://github.com/zhangleizlpd/no-vain-years-tech/issues/107)) ([2a66d36](https://github.com/zhangleizlpd/no-vain-years-tech/commit/2a66d36b24649115e5de78c00335dcc27128d782))

## [0.31.1](https://github.com/zhangleizlpd/no-vain-years-tech/compare/server-v0.31.0...server-v0.31.1) (2026-08-18)


### Bug Fixes

* **marketdata:** 心跳 served_by 归位活源链 —— 前瞻段覆写它会让主源之死不可观测 ([#101](https://github.com/zhangleizlpd/no-vain-years-tech/issues/101)) ([31c4318](https://github.com/zhangleizlpd/no-vain-years-tech/commit/31c43188d38a9e741fd0c1b0ea11fd2ae54d5c0c))

## [0.31.0](https://github.com/zhangleizlpd/no-vain-years-tech/compare/server-v0.30.0...server-v0.31.0) (2026-08-18)


### Features

* **core:** 062 交易日历前瞻视野与三态语义收口 —— 修三处生产静默失效 ([#99](https://github.com/zhangleizlpd/no-vain-years-tech/issues/99)) ([a5a73ab](https://github.com/zhangleizlpd/no-vain-years-tech/commit/a5a73abde0d9b6f1850fab3fb282bb2ee3072829))

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
