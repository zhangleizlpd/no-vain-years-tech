# AppModule import 图收窄 —— 67 个 boot-AppModule IT 改窄 boot

> 08-02 plan「⏭ 下一个 session 从哪接」指定的唯一主线：T-1 后 `import` CPU（≈330s）已超过
> `tests` CPU（≈286s）且容器线改造前后纹丝不动 —— 每个 worker 各自求值整张 NestJS 模块图，
> 而绝大多数 IT 只打单一业务域的路由。本轮把 80 个 `imports: [AppModule]` 文件里的 67 个
> 收窄到真实需要的 module 集，13 个蓄意保留（判定见下）。

## 结论速览

| 量（同机 `nx test server --skip-nx-cache` 全量） | 改造前（当日基线）                    | 改造后                     | Δ                                                                |
| ------------------------------------------------ | ------------------------------------- | -------------------------- | ---------------------------------------------------------------- |
| wall                                             | 76.24s                                | **68.99 / 69.12s**（2 轮） | **−9.4%**                                                        |
| `import` CPU                                     | 325.78s                               | **277.39 / 269.93s**       | **−15~17%（≈−52s，与 67×0.75s 单文件外推几乎 1:1，无并行放大）** |
| `transform` CPU                                  | 24.61s                                | 26.29 / 24.53s             | —                                                                |
| `tests` CPU                                      | 290.73s                               | 273.39 / 285.28s           | —                                                                |
| 用例                                             | 363 passed \| 10 skipped / 3211 \| 68 | **逐字一致**               | 零行为变更                                                       |

单文件 pilot（2 轮取稳，`nx test server <file> --skip-nx-cache`）：

| 配方                                                            | 单文件 import | 对照 AppModule 基线 1.53–1.58s |
| --------------------------------------------------------------- | ------------- | ------------------------------ |
| `[AuthModule]`                                                  | 0.71–0.88s    | −45%                           |
| `narrowTestModule([<Feature>Module])`（pilot 时为等价内联形态） | 0.65–0.80s    | −50%                           |
| `[AuthModule, <Feature>Module]`                                 | 0.87–1.05s    | −37%                           |

## 三配方与判定规则

1. **auth 族（31 文件）** → `imports: [AuthModule]`。auth 编排层传递携带 account + security，
   `/api/v1/accounts|auth/*` 路由全覆盖；**全仓 31 个命名限流桶的 `ThrottlerModule.forRootAsync`
   注册中枢就在 AuthModule**，故 auth 族天然保真限流配置。
2. **限流断言族（8 文件，非 auth）** → `imports: [AuthModule, <Feature>Module]`。
   断言 429/Retry-After 的 IT 换宽松桶 = 把被测对象抽掉；保住 AuthModule 即保住真配置。
3. **其余（28 文件）** → `imports: narrowTestModule([<Feature>Module])`
   （helper = `test/_support/narrow-boot.ts`，API 形态 per 08-02 plan「方案定型」#835 —— 横切
   注册内聚一处，与 `app.module.ts` 的同步义务集中在这一个文件）。收窄 boot 缺
   `THROTTLER:MODULE_OPTIONS` 时 `AccountIdThrottlerGuard` 在 DI 期直接炸（pilot 实测）；
   宽松单桶只为让 guard 可解析。**对定型方案的两点实证修正**：横切层只需 Throttler
   （Schedule/Logger 实证不需要，见下）；auth 族 / 限流断言族不能吃宽松注册（双注册 /
   抽被测对象），走显式形态。
   controller 上未注册的命名 `@Throttle` 引用被 guard 忽略不报错
   （先例 = `src/optionsdesk/optionsdesk.controller.spec.ts`，本轮再证）。

安全性论据（为什么收窄不引入静默风险）：

- 全局设施 `ProblemDetailFilter`(APP_FILTER) / CLS / ConfigModule 全在 SecurityModule，
  任何业务 module 传递携带；`ValidationPipe` + `setGlobalPrefix` 本就由各 IT 自挂。
- pino LoggerModule 仅 app.module/main.ts 引用，无 provider 注入 `PinoLogger` → 缺席零 DI 风险。
- `SchedulerRegistry` 全仓零使用者；`@Cron` 无 `ScheduleModule.forRoot` 时惰性，测试全部显式触发。
- 路由缺失 = inject 404 / provider 缺失 = DI 炸 —— **都是响亮失败**，misclassification 自暴露
  （portfolio-holdings pilot 的限流断言红即为实证）。

## 13 个蓄意保留 AppModule 的文件（别再当缺口收）

| 文件                                                                                                                                                            | 保留理由                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `alert-realtime-eval` / `timing-defense.p95` / `cancel.us4-send-code-anti-enum`                                                                                 | `RUN_PERF_IT` 门控块，默认 skip ⇒ 收窄正确性本地不可验（T-4「全绿不构成证据」）；且前者是 nightly-perf 刚修绿的现场，不冒险                         |
| `chat-streaming` / `ideation`                                                                                                                                   | `RUN_LLM_IT` 真 vendor 块（#815 曾在此静默断裂两天）                                                                                                |
| `ideation-asr-transcribe`(`RUN_ASR_SYNC_IT`) / `ideation-grounding`(`RUN_CODEINDEX_IT`) / `ideation-image-attachment`、`ideation-mockup-delivery`(`RUN_OSS_IT`) | 同上，env-gated 默认 skip                                                                                                                           |
| `marketdata.boot-015`                                                                                                                                           | 被测对象就是「AppModule 全 boot 下 marketdata 端口解析」，收窄 = 抽掉被测对象；文件含 2 处 boot                                                     |
| `chat-custom-instructions` / `chat-web-search` / `llm-tool-stream`                                                                                              | describe 标题写明「AppModule 全 boot DI」—— boot 模式是测试身份的一部分；改语义不改标题 = drift，改标题违反零标题变更纪律。孤儿闸拦下后人工判定保留 |

## 转换与验证纪律（沿 P4.9/T-1 先例）

- 一次性脚本（scratchpad，不入库）+ **孤儿引用闸**：转换后仍引用 `AppModule` → 整文件跳过交人工
  （本轮拦下上表最后 3 个标题引用文件，零半转换文件写出）。
- `describe`/`it` 标题集合逐文件比对：80 文件 **零变化**（676 行 diff 为空）。
- `nx typecheck server` 绿（#834 后覆盖全部 `test/**`，孤儿 import 在类型层无所遁形）。
- 全量两轮干净复验 + 用例数逐字比对（见结论速览）。
- 分类管道自己踩过一次假阴性：限流断言扫描跑在 pilot 编辑之后，`rg -l 'imports:[AppModule]'`
  名单已不含 pilot 文件 ⇒ portfolio-holdings 漏判，靠宽松桶下 429 断言**响亮变红**抓回。
  教训同 plan §「验证管道自己会骗你」：**分类清单必须锚定改动前的原始名单**。

## 复跑命令

```bash
pnpm exec nx test server --skip-nx-cache           # 全量（含 unit + it）
pnpm exec nx test server <file> --skip-nx-cache    # 单文件 A/B
```
