# Changelog

<!-- release-please 在 `# Changelog` 之后 prepend 新版本条目；下面这段说明会一直沉在末尾。 -->

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
