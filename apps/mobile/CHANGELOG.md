# Changelog

<!-- release-please 在 `# Changelog` 之后 prepend 新版本条目；下面这段说明会一直沉在末尾。 -->

## [0.15.0](https://github.com/zhangleizlpd/no-vain-years-tech/compare/mobile-v0.14.0...mobile-v0.15.0) (2026-08-31)


### Features

* **optionsdesk:** 068 实时窄召回两段式重建 —— 窗即召回, ADR-0068 P2 片 ([#291](https://github.com/zhangleizlpd/no-vain-years-tech/issues/291)) ([ed98d28](https://github.com/zhangleizlpd/no-vain-years-tech/commit/ed98d28d3018fa38eb0f28a731f6f0c99a01b1fc))
* **optionsdesk:** 069 清链与行军选档 —— 凸包净链+φ形状行军+逐档可解释, ADR-0068 P3 片 ([#293](https://github.com/zhangleizlpd/no-vain-years-tech/issues/293)) ([4d5d083](https://github.com/zhangleizlpd/no-vain-years-tech/commit/4d5d0837dd02facaa674734f4bd305fea0e567f0))
* **optionsdesk:** 070 离线档收租阶梯 —— 意图视角切 fwd 阶梯呈现、计划/执行同口径 ([#295](https://github.com/zhangleizlpd/no-vain-years-tech/issues/295)) ([c5be461](https://github.com/zhangleizlpd/no-vain-years-tech/commit/c5be4611dc914fc84ddd9ba9ac28b606cf80a7b8))
* **optionsdesk:** 071 宽价差机会标 —— 收租点差闸放行「砸 bid 也达档」的宽市场腿 ([#300](https://github.com/zhangleizlpd/no-vain-years-tech/issues/300)) ([5a2883e](https://github.com/zhangleizlpd/no-vain-years-tech/commit/5a2883e6368a34eabe9f63193355bc51e90eb980))

## [0.14.0](https://github.com/zhangleizlpd/no-vain-years-tech/compare/mobile-v0.13.0...mobile-v0.14.0) (2026-08-23)


### Features

* **marketdata:** 066 港股期权接入与锚冷启动开通港股 ([#169](https://github.com/zhangleizlpd/no-vain-years-tech/issues/169)) ([ea74b5f](https://github.com/zhangleizlpd/no-vain-years-tech/commit/ea74b5fa4975957d2a5dbc9888c74a9e3c9ce908))

## [0.13.0](https://github.com/zhangleizlpd/no-vain-years-tech/compare/mobile-v0.12.1...mobile-v0.13.0) (2026-08-22)


### Features

* **optionsdesk:** 065 雷达按市场分页签 —— 美股 / 港股 ([#118](https://github.com/zhangleizlpd/no-vain-years-tech/issues/118)) ([214a3a5](https://github.com/zhangleizlpd/no-vain-years-tech/commit/214a3a50e78625d83e29d2adc9ecab6a7b161fb7))


### Bug Fixes

* **optionsdesk:** 空态文案 chainNotReady 描述的是 060 冷启动与 [#124](https://github.com/zhangleizlpd/no-vain-years-tech/issues/124) 之前的世界 ([#141](https://github.com/zhangleizlpd/no-vain-years-tech/issues/141)) ([f2440a7](https://github.com/zhangleizlpd/no-vain-years-tech/commit/f2440a7f3dfdee8af5f14b74ebab55f382e0c7f2))

## [0.12.1](https://github.com/zhangleizlpd/no-vain-years-tech/compare/mobile-v0.12.0...mobile-v0.12.1) (2026-08-21)


### Bug Fixes

* **core:** 064 收尾 —— market-state 限频修复 + 档位条文案与去重 + 窗内数回写 ([#126](https://github.com/zhangleizlpd/no-vain-years-tech/issues/126)) ([70765c5](https://github.com/zhangleizlpd/no-vain-years-tech/commit/70765c533ca1cfa5581f3bff5a67b33565fd17e9))

## [0.12.0](https://github.com/zhangleizlpd/no-vain-years-tech/compare/mobile-v0.11.0...mobile-v0.12.0) (2026-08-19)


### Features

* **optionsdesk:** 064 美股期权腿盘中实时报价 ([#119](https://github.com/zhangleizlpd/no-vain-years-tech/issues/119)) ([38216ae](https://github.com/zhangleizlpd/no-vain-years-tech/commit/38216aed67882a0da833a0457f66475777b12b71))

## [0.11.0](https://github.com/zhangleizlpd/no-vain-years-tech/compare/mobile-v0.10.1...mobile-v0.11.0) (2026-08-18)


### Features

* **marketdata:** 061 行情实时面 + 美股正股盘中价接入期权台雷达 ([#92](https://github.com/zhangleizlpd/no-vain-years-tech/issues/92)) ([9069d3f](https://github.com/zhangleizlpd/no-vain-years-tech/commit/9069d3f0af6dcd8ac86667f93f640cad61f79cbb))

## [0.10.1](https://github.com/zhangleizlpd/no-vain-years-tech/compare/mobile-v0.10.0...mobile-v0.10.1) (2026-08-16)


### Bug Fixes

* **core:** 图片对象存储迁往账号 C —— 账号 B 的 OSS 欠费停服,顺带结掉「存绝对 URL」的老账 ([#66](https://github.com/zhangleizlpd/no-vain-years-tech/issues/66)) ([b08e4c4](https://github.com/zhangleizlpd/no-vain-years-tech/commit/b08e4c4a5835eaf2741a722de0e826446dff8746))

## [0.10.0](https://github.com/zhangleizlpd/no-vain-years-tech/compare/mobile-v0.9.0...mobile-v0.10.0) (2026-08-14)


### Features

* **marketdata:** 054 mock 下 28 个采集口拒绝写库 + provider 非法值 boot 抛 ([#39](https://github.com/zhangleizlpd/no-vain-years-tech/issues/39)) ([b2455da](https://github.com/zhangleizlpd/no-vain-years-tech/commit/b2455daf507890522aa5a5cb44c853f853a3dbc9))
* **optionsdesk:** 052 选约检索分层落地 + 三视角逐层判据重梳 ([#34](https://github.com/zhangleizlpd/no-vain-years-tech/issues/34)) ([90e8b74](https://github.com/zhangleizlpd/no-vain-years-tech/commit/90e8b743bf76cce65d1f7eef51ddd1ae827f84e9))
* **optionsdesk:** 053 选约表查询下沉 —— 每视角独立请求 + 响应收窄 + 表达层截断 ([#41](https://github.com/zhangleizlpd/no-vain-years-tech/issues/41)) ([b17b4d6](https://github.com/zhangleizlpd/no-vain-years-tech/commit/b17b4d6d8cc9d73278ce6b4705d448f769ab8676))
* **optionsdesk:** 055 标的链分析报表 —— 打开选约表之前先看清整条链的机会分布 ([#46](https://github.com/zhangleizlpd/no-vain-years-tech/issues/46)) ([0312c0f](https://github.com/zhangleizlpd/no-vain-years-tech/commit/0312c0f0b3af365d8d39e2a8f4eb52afbb92d0ff))
* **optionsdesk:** 056 检索条件抽屉版式重构 —— 输入位可辨识 + 右边界对齐 + OR 显式化 + 行集统一 ([#43](https://github.com/zhangleizlpd/no-vain-years-tech/issues/43)) ([e5f7554](https://github.com/zhangleizlpd/no-vain-years-tech/commit/e5f7554001910f3ee20f57b1c27236fe97e10604))


### Bug Fixes

* **mobile:** 把 pretty-format 钉回 CJS 入口 —— 修 dev bundle 整屏白 ([#42](https://github.com/zhangleizlpd/no-vain-years-tech/issues/42)) ([5399547](https://github.com/zhangleizlpd/no-vain-years-tech/commit/539954787dacc5f00524b892159e8e4d2da380b2))
* **optionsdesk:** 契约到手前点的那一下 Tab 被静默丢弃 —— 三个 Tab 恒可点, 却有一个窗口点了不作数 ([#31](https://github.com/zhangleizlpd/no-vain-years-tech/issues/31)) ([6c2ac79](https://github.com/zhangleizlpd/no-vain-years-tech/commit/6c2ac793278a75e24e7fa2f48c3f986a4d0d85a6))
* **optionsdesk:** 月度链 chip 被固定高裁字 + 补可见性断言 —— 真机复看列头收口 ([#51](https://github.com/zhangleizlpd/no-vain-years-tech/issues/51)) ([0fd7afe](https://github.com/zhangleizlpd/no-vain-years-tech/commit/0fd7afe42d0a87b462b965563157a8422bbbc8cf))

## [0.9.0](https://github.com/zhangleizlpd/no-vain-years-tech/compare/mobile-v0.8.0...mobile-v0.9.0) (2026-08-12)


### Features

* **optionsdesk:** 049 选约表横滑范式换代 + 意图 Tab 重设计 ([#20](https://github.com/zhangleizlpd/no-vain-years-tech/issues/20)) ([cb2d150](https://github.com/zhangleizlpd/no-vain-years-tech/commit/cb2d150526ae13ec934a894ac10c341cbddceb70))
* **optionsdesk:** 050 选约引擎 server 三层重构 —— 召回 / 打标 / 精排 ([#23](https://github.com/zhangleizlpd/no-vain-years-tech/issues/23)) ([fc3b7e9](https://github.com/zhangleizlpd/no-vain-years-tech/commit/fc3b7e9aeee1b6e8548cbd024ef95a00e29ac249))
* **optionsdesk:** 051 选约表显示口径跟进 —— 七块契约消费 + 按视角拆的排除计数 ([#29](https://github.com/zhangleizlpd/no-vain-years-tech/issues/29)) ([0d6e531](https://github.com/zhangleizlpd/no-vain-years-tech/commit/0d6e53145d28b84473df65cec63d393346d3dc64))
* **optionsdesk:** 选约表补挂牌量 + 价格统一 2 位 —— 顺带把横滑自激环定案成 ADR-0063 ([#18](https://github.com/zhangleizlpd/no-vain-years-tech/issues/18)) ([6686756](https://github.com/zhangleizlpd/no-vain-years-tech/commit/66867567d288b1433309e2d7c9e3dc8f96a79bda))

## 0.8.0 之前的历史

本仓转公开时截断（2026-08-08）。逐版本条目、PR 链接与作者署名完整保留在**私有归档仓**
`zhangleizlpd/no-vain-years` @ tag `archive/pre-public-split`。

截断而非保留的理由：release-please 生成的每条条目都带 PR / commit 超链，而那些链接指向
迁移前的仓库路径 —— 现已全部失效，且把仓库标识写进了一份逐行重复上百次的文件里
（per [`docs/conventions/information-boundary.md`](../../docs/conventions/information-boundary.md)）。

版本号的单一来源是 `.release-please-manifest.mobile.json`，不依赖本文件 —— 截断不影响 release-please 续算下一版。
截断时版本：**0.8.0**。
