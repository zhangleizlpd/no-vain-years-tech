/**
 * Fastify adapter 传输层选项 (platform infra, per ADR-0041)。**main.ts 与 spec 消费同一常量**
 * —— 直接在 `new FastifyAdapter(...)` 里写字面量会让这个设置无测可依、静默回归。
 *
 * ## 为什么必须开 trustProxy
 *
 * prod 拓扑 = 客户端 → nginx(边缘, 自持 Let's Encrypt 证书终结 TLS, `conf.d/` 无 real_ip 指令)
 * → `app:3000`(docker 网络, compose 里 app **不发布公网端口**)。⇒ socket 源地址恒为 nginx 在
 * 网桥上的私网 IP, `@Ip()` 直接拿它会被 `scrubPrivateIp` 判私网抹成 null。
 *
 * 2026-08-15 prod 取证(只读): `account.refresh_token` **150 行 / null_ip 150 / has_ip 0**,
 * 跨整表历史零例外。代码侧原先的前提「trustProxy 未启用, 直连部署恒见真实公网 IP」在 prod
 * 从不成立 —— app 从来不是直连。
 *
 * 后果不止「登录管理地点恒显 —」: per-IP 限流桶(`sms:<ip>` 24h 50 / cancel-deletion per-IP
 * 5-10/60s)全体用户共用**同一个 key**, 既拦不住单个攻击者, 又是全站自伤天花板(总量打满即
 * 所有人一起被挡)。per-phone 与 `me:<accountId>` 两类桶不受影响, 那是主护栏。
 *
 * ## 为什么按地址信任 nginx, 而不是按跳数 (`1`) 或 `true`
 *
 * nginx 侧配的是 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`, 它把真实 socket
 * 地址**追加**在客户端自带值之后 ⇒ 候选序列 = `[socket 地址, ...XFF 反向]`。proxy-addr 从 socket
 * 起逐项走, 遇到第一个**不受信**的地址即停: socket = nginx 的私网地址(受信) → 下一项 = nginx
 * 追加的真实客户端公网地址(不受信) → `req.ip` 取它; 客户端伪造的条目恒落在更靠前的下标、**永远
 * 选不中**。换成 `true` 则整条 XFF 都被信任 ⇒ 客户端可自报任意 IP 绕开 per-IP 限流。
 *
 * 原先写的是 `trustProxy: 1`(只信一跳), 对公网客户端效果与此相同。fastify 5.12 起数字形式改为
 * **一律不信任**(EVIDENCE: fastify@5.12.5 `lib/request.js` `getTrustProxyFn` 对 number 返回恒
 * false, `docs/Reference/Server.md#trustproxy` 注明「Hop-count-only trust is disabled」), 继续写
 * `1` 会让 `req.ip` 退回 nginx 地址 —— 即上面 2026-08-15 那场事故的形态。
 *
 * `uniquelocal` = proxy-addr 内置的私网段(10/8、172.16/12、192.168/16、fc00::/7), 覆盖 compose
 * 默认网桥(该网段由 docker 分配、compose 未钉死, 故不写具体 CIDR, 免得网络重建后静默失效);
 * `loopback` 覆盖本机直连与 `app.inject`。残余面: 来自私网的请求可自报 XFF —— app 不发布公网
 * 端口, 能从私网直达它的只有本机与机队内部服务。
 *
 * 🚨 **这个取值与拓扑绑定**: 若将来在 nginx 前再加一层**公网**地址的代理(CDN / SLB), 必须把那层
 * 的地址段加进来, 否则 `req.ip` 会变成那一层的地址。识别判据 = `ops/host/nginx/conf.d/` 出现
 * `set_real_ip_from` / `real_ip_header`, 或域名证书不再由 nginx 自持。反向失效是安全的: 若 nginx
 * 停止下发 XFF, `req.ip` 退回 socket 地址(= 改前行为), 降级不报错。
 *
 * 行为契约由 `http-adapter.options.spec.ts` 钉住(含伪造 XFF 的决定性负例)。
 */
export const HTTP_ADAPTER_OPTIONS = { trustProxy: 'loopback, uniquelocal' };
