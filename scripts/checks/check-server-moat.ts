#!/usr/bin/env node
/**
 * check-server-moat.ts — ts-morph AST 护城河探针 (Plan 05-24 R-6, 合并
 * ADR-0034 Evolutionary Path Stage C). 把 ADR-0043 §5「当前仅约定」的两条
 * 边界从人工 / AI CR 引导转为机器强制:
 *
 *   Check 1 — 数据护城河 (ADR-0043 §5 + §3 R1/R2):
 *     某 bounded context 访问**非自有** Prisma model 的 `<x>.<model>.<op>()`:
 *       - 写操作 (create/update/upsert/delete/...) → 永远违规 (R2: 跨 ctx 写
 *         必须委托对方 UseCase, 禁 `tx.<otherTable>.*`)。
 *       - 读操作 (find* / count / aggregate / ...) → 违规, **除非**该访问语句上方标
 *         `// CROSS-CONTEXT-READ:` (catalog Q7-B 临时只读逃生口)。
 *     boundaries ESLint 看不见 Prisma 调用 (它只管 import 方向), 故此探针正交补位。
 *
 *   Check 2 — 跨 ctx 注入注释 (ADR-0034 Stage C, R2 CROSS-CTX-SYNC):
 *     构造器注入参数, 若其类型 import 自**另一个业务 context** (auth ↔ account;
 *     security 是平台基座, 豁免 per ADR-0041) → 该参数上方必须有
 *     `// CROSS-CONTEXT-{SYNC,ASYNC,READ}:` 注释 (注入点 = 行为耦合点)。
 *     纯函数 (normalizePhone) / 异常类 / NestJS Module import 不是构造器注入,
 *     天然不在扫描面 — 注释信号不被稀释。
 *
 * 设计同 check-adr-index.ts: 始终全量扫描 (护城河是 holistic invariant), lefthook
 * 的 glob 只决定**是否**跑, 不决定**扫什么**。语法级遍历 (不做类型解析) → 快,
 * 不依赖 `prisma generate` 是否跑过。
 *
 * Usage: pnpm tsx scripts/checks/check-server-moat.ts
 * Exit:  0 全过 / 1 ≥1 违规
 *
 * Deps (@nvy/checks): ts-morph; run via root tsx。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Node, Project, SyntaxKind, type ParameterDeclaration, type SourceFile } from 'ts-morph';

const SERVER_ROOT = 'apps/server';
const SRC_GLOBS = [
  `${SERVER_ROOT}/src/**/*.ts`,
  `!${SERVER_ROOT}/src/**/*.spec.ts`,
  `!${SERVER_ROOT}/src/**/*.test.ts`,
  `!${SERVER_ROOT}/src/**/*.it.spec.ts`,
  `!${SERVER_ROOT}/src/generated/**`,
  `!${SERVER_ROOT}/src/__smoke__/**`,
];
const SCHEMA_PATH = `${SERVER_ROOT}/prisma/schema.prisma`;

/**
 * 业务 context 的 Prisma model 归属 (accessor = camelCase model 名)。
 * 只声明**已落地**的 model; dormant model (db pull 带入但尚未接线的
 * credential) 故意不列 —
 * 它们 0 访问, 一旦未来被跨 ctx 访问, Check 1 会以「未声明归属」报错, 逼迫
 * 接线者显式声明 owner (defense-in-depth, 不让新表悄悄绕过护城河)。
 */
const MODEL_OWNERSHIP: Record<string, string> = {
  account: 'account',
  outboxEvent: 'security',
  // refreshToken 归 security 平台层: RefreshTokenService 持久化/轮换/撤销 (003-tokens)。
  refreshToken: 'security',
  // accountSmsCode 归 auth: 注销/撤销码生命周期由 auth 编排 (DeletionCodeStore, 004),
  // 镜像 login 的 Redis sms-code.store; account ctx 不碰码行 (匿名化不删码, plan D6)。
  accountSmsCode: 'auth',
  // wechatBinding 归 account: 微信绑定数据 (account↔openid)。account 三原语
  // (commit-bind/unbind/inspect) 独占写读; auth 编排 (bind/unbind/send-code) 经
  // 两段式委托跨 moat (CROSS-CONTEXT-SYNC), 不直碰 prisma.wechatBinding (010)。
  wechatBinding: 'account',
  // portfolioPreference 归 portfolio (011, 第 4 bounded context; ADR-0046 单行模型):
  // 证券市场准入偏好单行 active_markets text[], get/update market-preferences 两 UC
  // 独占读写 (R1 自有表); 海外市场恒由字典投影不入集合。未登记则 portfolio UC 读自己
  // 的表即 moat-unmapped 硬拒。
  portfolioPreference: 'portfolio',
  // brokerAccount 归 portfolio (012, 第 2 组 operation; 多行表): 券商账户归属字典池,
  // list/bind/delete-broker-account 三 UC 独占读写 (R1 自有表, intra 无跨 ctx)。默认账户
  // 读侧虚拟派生不落行。未登记则 portfolio UC 读自己的表即 moat-unmapped 硬拒。
  brokerAccount: 'portfolio',
  // group / watchlistItem 归 portfolio (013, 第 3 组 operation; 自选列表): 分组 + 自选
  // 标的项, 9 个 watchlist UC 独占读写 (R1 自有表, intra 无跨 ctx; 行情/搜索由 mobile
  // client-side merge 015, server 段零跨 ctx per ADR-0048)。未登记则 portfolio UC 读自己
  // 的表即 moat-unmapped 硬拒。
  group: 'portfolio',
  watchlistItem: 'portfolio',
  // marketdata 6 张事实/注册表归 marketdata (015, 第 5 bounded context; ADR-0047 可插拔
  // 访问层): 4 读 UC (search/quote/detail/bars) + adapter 独占读写 (R1 自有表, intra 叶子
  // 无跨 ctx)。Instrument↔事实表同 schema intra FK。未登记则 marketdata UC 读自己的表即
  // moat-unmapped 硬拒。
  instrument: 'marketdata',
  dailyBar: 'marketdata',
  fundamentalSnapshot: 'marketdata',
  financialMetric: 'marketdata',
  corporateAction: 'marketdata',
  adjustmentFactor: 'marketdata', // 019 复权因子版本表 (executor/backfill 独占读写, intra)。
  tradingDay: 'marketdata',
  calendarSyncHealth: 'marketdata', // 044 日历填充心跳 (TradingCalendarSyncService 写 / ops 探针直读 PG, intra 无 FK)。
  calendarCoverage: 'marketdata', // 062 日历覆盖声明 (TradingCalendarSyncService 写 / DbTradingCalendarAdapter + alert 只读, intra 无 FK)。
  shortSellingDaily: 'marketdata', // 039 US1 做空日频 (executor/backfill 独占读写, intra FK→instrument)。
  connectHoldingDaily: 'marketdata', // 039 US1 南向持股日频 (executor/backfill 独占读写, intra)。
  fundHolding: 'marketdata', // 039 US2 公募基金持股 (executor/backfill 独占读写, intra FK→instrument)。
  fundCompanyHolding: 'marketdata', // 039 US2 基金公司持股 (executor/backfill 独占读写, intra)。
  indexMembership: 'marketdata', // 039 US3 所属指数归属 (executor 覆盖式 deleteMany+createMany 独占读写, intra FK→instrument)。
  volatilityDaily: 'marketdata', // 040 US1 波动率日频 (executor/backfill × 多窗口独占读写, intra FK→instrument)。
  hotSnapshot: 'marketdata', // 040 US2 热度精选快照 (executor 按 dataDate upsert × type 循环独占读写, intra FK→instrument)。
  buybackEvent: 'marketdata', // 041 US1 回购事件 (executor/backfill 区间独占读写, intra FK→instrument)。
  equityChange: 'marketdata', // 041 US2 股本变动事件 (executor/backfill 区间独占读写, intra FK→instrument)。
  shareholderChange: 'marketdata', // 041 US3 股东权益变动事件 (executor/backfill 区间独占读写, 嵌套 L/S payload, intra FK→instrument)。
  allotmentEvent: 'marketdata', // 041 US4 配股事件 (executor/backfill 区间独占读写, 港股极罕见零样本 payload, intra FK→instrument)。
  revenueSegment: 'marketdata', // 042 US1 营收构成 (executor/backfill 区间独占读写, dataList 展开 typed 子行, intra FK→instrument)。
  shareholderSnapshot: 'marketdata', // 042 US2 最新股东 (executor/backfill 区间独占读写, 嵌套 L/S/P payload + contentHash, intra FK→instrument)。
  employeeSnapshot: 'marketdata', // 042 US3 员工 (executor/backfill 区间独占读写, dataList 展开 typed 子行 + displayType 进 NK, intra FK→instrument)。
  industryClassification: 'marketdata', // 043 US1 所属行业 (executor 覆盖式 deleteMany+createMany 独占读写, hsi 3 级层级快照, intra FK→instrument)。
  announcement: 'marketdata', // 043 US2 公告 (executor/backfill 区间独占读写, 超大表只存元数据 linkUrl 天然唯一 NK, intra FK→instrument)。
  // 046 optionsdesk M2a 标的级 IV + 指数日线 3 表归 marketdata (市场事实, p3b §4.5): marketdata
  // 的 executor/backfill 独占**写** (R1 自有表); 跨 ctx 面 = optionsdesk 两个读端 Q7-B 只读直查
  // (CROSS-CONTEXT-READ 注释强制)。underlyingIvDaily/underlyingIvHistory intra FK→instrument;
  // usIndexDaily 无 instrument 关联 (指数级, vendor 不收录该代码 ⇒ 库里无对应 Instrument 行)。
  underlyingIvDaily: 'marketdata',
  underlyingIvHistory: 'marketdata',
  usIndexDaily: 'marketdata',
  // 047 optionsdesk M2b 期权链 3 表归 marketdata (市场事实, plan D-ARCH-1 / FR-053): marketdata
  // 的 executor/backfill 独占**写** (R1 自有表); 跨 ctx 面 = optionsdesk 选约读端 Q7-B 只读直查
  // (CROSS-CONTEXT-READ 注释强制)。optionContract/earningsEvent intra FK→instrument;
  // optionDailySnapshot intra FK→optionContract (合约级非标的级)。
  optionContract: 'marketdata',
  optionDailySnapshot: 'marketdata',
  earningsEvent: 'marketdata',
  // 同步配置/审计 3 表 (016): 同步管线 + scheduler + backfill CLI 独占读写 (R1 自有表,
  // intra 叶子无跨 ctx)。未登记则 marketdata 同步代码读自己的新表即 moat-unmapped 硬拒。
  syncDimension: 'marketdata',
  syncBlacklist: 'marketdata',
  syncRun: 'marketdata',
  // 维度依赖边表 (017, ADR-0049 PG 真相层): tick/flow 装配器 + trigger CLI cascade 独占
  // 读写 (R1 自有表, intra 叶子无跨 ctx)。未登记则 marketdata 调度代码读自己的表即硬拒。
  syncDependency: 'marketdata',
  // 锚首建冷启动运行记录 (060, plan D7): 写方在 marketdata (AnchorColdStartUseCase 覆盖式
  // 单行 upsert, R1 自有表)。落 marketdata 而非 optionsdesk 是因为**写它的人在这边** ——
  // optionsdesk 只负责建锚时 publish 一条 outbox 事件, 全程不碰本表 (反向也无人读)。
  anchorColdStartRun: 'marketdata',
  // alert 4 表归 alert (021, 第 6 bounded context; ADR-0052 调度自治预警引擎): CRUD/
  // 评估/消息 UC 独占读写 (R1 自有表)。跨 ctx 面 = alert 评估读 marketdata 的
  // dailyBar/instrument (Q7-B 只读直查, CROSS-CONTEXT-READ 注释强制); 反向无人读 alert。
  alert: 'alert',
  alertCondition: 'alert',
  alertTrigger: 'alert',
  alertReadCursor: 'alert',
  // push 2 表归 alert (022, 推送送达; ADR-0052 复审记录): push_binding 绑定 (EP9/EP10) +
  // push_delivery 自有 transactional outbox 兼留痕 (plan D2/D3)。绑定/fan-out/dispatch UC
  // 独占读写 (R1 自有表); 外呼极光走 gateway port = vendor I/O 非跨 ctx, alert 仍叶子 ctx。
  pushBinding: 'alert',
  pushDelivery: 'alert',
  // holding / closedPosition / tradeRecord 归 portfolio (025, 第 5 组 operation;
  // 自有持仓导入): import/list UC 独占读写 (R1 自有表)。跨 ctx 面 = import UC 读
  // marketdata 的 instrument 批查可识别性落 quotable 列 (Q7-B 只读直查,
  // CROSS-CONTEXT-READ 注释强制); 反向无人读这 3 表。
  holding: 'portfolio',
  closedPosition: 'portfolio',
  tradeRecord: 'portfolio',
  // conversation / message 归 chat (027, 第 7 bounded context; ADR-0032 Q4 全新领域)。
  // 建会话 / 取消息 / 流式发消息 UC 独占读写 (R1 自有表)。chat 是**叶子 ctx**: accountId
  // 来自 JWT 不读 account 表, 零跨 ctx 业务调用; 大模型流式走 LlmProvider port = vendor I/O
  // 非跨 ctx; 反向无人读这 2 表。
  conversation: 'chat',
  message: 'chat',
  // chatPreference 归 chat (031, 账号级自定义指令偏好)。读/upsert UC 独占自有表 (R1),
  // accountId 标量列无 FK relation (同 conversation/message); 反向无人读此表。
  chatPreference: 'chat',
  // ideaSession / ideaTurn / requirementsDraft 归 ideation (032, 第 8 bounded context;
  // ADR-0057 需求灵感澄清)。建会话 / 取轮次 / 两相剧本推进 UC 独占读写 (R1 自有表)。
  // ideation 是**叶子 ctx**: accountId 来自 JWT 不读 account 表, 零跨 ctx 业务调用
  // (尤其不读 chat); 大模型走 integrations/llm port = vendor I/O 非跨 ctx; 反向无人读这 3 表。
  ideaSession: 'ideation',
  ideaTurn: 'ideation',
  requirementsDraft: 'ideation',
  // ideaAttachment 归 ideation (036 图片标注首建)。带图轮上传凭证 UC + clarify-turn UC 独占
  // 读写 (R1 自有表): 烧录图 ossKey + annotationsJson 元数据, 归属随 session accountId, 无 FK。
  ideaAttachment: 'ideation',
  // ideationMockup 归 ideation (037 mockup 交付链路首建)。写记录 UC append-only insert + 读列表
  // UC 倒序查 (R1 自有表): objectKey + screens 逐屏标签 Json, 归属随 session accountId, 无 FK。
  // worker-token 端点据 claimed agentQueueEvent (// CROSS-CONTEXT-READ) 派生 scope 后写本表。
  ideationMockup: 'ideation',
  // agentQueueEvent 归 agent-bridge (第 9 bounded context; App→本地 agent 通用事件通路
  // master plan 06-26)。claim/ack/result UC 独占读写 (R1 自有表, $queryRaw 原子 claim);
  // accountId 标量列无 FK relation (逻辑引用 JWT sub); 反向无人读此表 (叶子, 入队走 R3 Outbox 消费)。
  agentQueueEvent: 'agent-bridge',
  // promptConfig 归 ideation: 访谈人设等可运营 LLM 文案 (key 寻址), clarify-turn UC 只读,
  // 后续管理控制台维护。账号无关全局配置, 无跨 ctx (本 ctx 独占)。
  promptConfig: 'ideation',
  // anchor / anchorChange 归 optionsdesk (045, 第 10 bounded context; ADR-0062 期权台)。
  // 锚 CRUD / 复审 / 雷达读 / 痕迹写 UC 独占读写 (R1 自有表)。跨 ctx 面 = **双向各一条 Q7-B
  // 只读直查**: ① optionsdesk 读 marketdata 的 instrument/dailyBar 回填 last_close 单向投影;
  // ② marketdata 采集闸读 anchor 的 ticker 集合刷自有 Instrument.needSync —— 两处均须
  // CROSS-CONTEXT-READ 注释。anchorChange.anchorId 无 FK relation (删锚不级联删痕迹, FR-031)。
  anchor: 'optionsdesk',
  anchorChange: 'optionsdesk',
  // anchorSubmission 归 optionsdesk (059 锚待审收件箱, FR-011)。提交端点独占写 (R1 自有表),
  // **零读取面**: 审阅走 DB 直连, 采纳 = 本人经导入口重放一次 ⇒ 本表到锚表**没有代码路径**,
  // 那正是 FR-012「系统 MUST NOT 存在第二条写锚路径」的结构性保证。跨 ctx 面 = 0。
  anchorSubmission: 'optionsdesk',
  // researchReport 归 research (057, 第 11 bounded context; ADR-0065 研报库)。投递 UC 独占
  // 读写 (R1 自有表)。**跨 ctx 面 = 0**: symbol 存归一后的 `market:code` 裸字符串, 不建到
  // marketdata.instrument 的外键、不做存在性校验 —— 校验会拒绝合法新标的, 且会引入本可
  // 避免的 Q7-B 依赖 (对齐 014「仅共享 market:code 逻辑键」)。故本表既不该被他 ctx 读,
  // 也不该反向读他 ctx 的表; 出现任一方向即是设计漂移, 探针会红。
  researchReport: 'research',
};

const WRITE_OPS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
]);
const READ_OPS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);
const PRISMA_OPS = new Set([...WRITE_OPS, ...READ_OPS]);

/** 平台基座 — 作为 import 目标永远豁免注释 (per ADR-0041)。 */
const PLATFORM_CTX = 'security';

/**
 * 业务 bounded context (per ADR-0032 当前 3-ctx 模型: auth 编排 / account 数据 /
 * security 平台基座)。Check 2 只在「业务 ctx 注入另一业务 ctx」时要求注释 ——
 * security 平台基座 + app 组合根 + observability 等非业务 seg 不在此列。
 * 新增 bounded context (走 ADR-0032 sunset trigger 评估) 时, 同步加入本集合。
 */
const BUSINESS_CTX = new Set([
  'auth',
  'account',
  'portfolio',
  'marketdata',
  'alert',
  'chat',
  'ideation',
  'optionsdesk',
  'research',
]);

interface Violation {
  file: string;
  line: number;
  rule: 'moat-write' | 'moat-read' | 'moat-unmapped' | 'cross-ctx-annotation';
  message: string;
}

/** 从 schema.prisma 抽出全部 model → camelCase accessor 集合 (真 Prisma model 锚)。 */
function readSchemaAccessors(schemaPath: string): Set<string> {
  const accessors = new Set<string>();
  if (!existsSync(schemaPath)) return accessors;
  const text = readFileSync(schemaPath, 'utf-8');
  for (const m of text.matchAll(/^model\s+([A-Za-z_]\w*)\s*\{/gm)) {
    const name = m[1];
    accessors.add(name.charAt(0).toLowerCase() + name.slice(1));
  }
  return accessors;
}

/** src/<seg>/... → seg (context); src 直属文件 / 非 src → null。 */
function ctxOfFile(filePath: string): string | null {
  const m = filePath.replace(/\\/g, '/').match(/\/src\/([^/]+)\//);
  return m ? m[1] : null;
}

/** 相对 import specifier → 目标 context (resolve 后落 src/<seg>/);非 src 内 → null。 */
function ctxOfSpecifier(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null; // 外部包, 不跨 ctx
  const resolved = resolve(dirname(fromFile), specifier).replace(/\\/g, '/');
  const m = resolved.match(/\/src\/([^/]+)(?:\/|$)/);
  return m ? m[1] : null;
}

/**
 * node 起始行**紧邻上方**的连续注释文本 (遇空行 / 代码行即停)。
 * ts-morph 的 leading comment 归属随 trivia 边界漂移 (param 注释可能挂在前一个
 * 逗号的 trailing trivia), 故用确定性的行级回溯, 不依赖 getLeadingCommentRanges。
 */
function contiguousCommentAbove(sf: SourceFile, node: Node): string {
  const lines = sf.getFullText().split('\n');
  const startIdx = node.getStartLineNumber() - 1; // 0-based; getStart() 跳过 leading trivia
  const collected: string[] = [];
  for (let i = startIdx - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.endsWith('*/')) {
      collected.push(t);
      continue;
    }
    break; // 空行或代码行 → 注释块结束
  }
  return collected.join('\n');
}

/** 构造器参数类型的首个类型名 (TypeReference identifier);取不到 → null。 */
function paramTypeName(param: ParameterDeclaration): string | null {
  const typeNode = param.getTypeNode();
  if (!typeNode) return null;
  if (Node.isTypeReference(typeNode)) return typeNode.getTypeName().getText();
  // 退化: 取类型文本的首段 identifier (覆盖 `Foo`、`Foo<Bar>` 等)。
  const text = typeNode.getText().trim();
  const m = text.match(/^[A-Za-z_]\w*/);
  return m ? m[0] : null;
}

/** FS-driven 全量扫描 (CLI 入口): 从 glob 装载 + 读 schema.prisma 锚。 */
export function scanServerMoat(opts?: { srcGlobs?: string[]; schemaPath?: string }): Violation[] {
  const schemaAccessors = readSchemaAccessors(opts?.schemaPath ?? SCHEMA_PATH);
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: false },
  });
  project.addSourceFilesAtPaths(opts?.srcGlobs ?? SRC_GLOBS);
  return scanSourceFiles(project.getSourceFiles(), schemaAccessors);
}

/**
 * 纯扫描核心 (语法级遍历 SourceFile[])。schemaAccessors = 真 Prisma model 锚集合。
 * 与 FS / glob 解耦 → 单测可喂 in-memory ts-morph fixture (见 check-server-moat.spec.ts)。
 */
export function scanSourceFiles(
  sourceFiles: SourceFile[],
  schemaAccessors: Set<string>,
): Violation[] {
  const violations: Violation[] = [];
  for (const sf of sourceFiles) {
    const fileCtx = ctxOfFile(sf.getFilePath());
    checkDataMoat(sf, fileCtx, schemaAccessors, violations);
    checkInjectionAnnotations(sf, fileCtx, violations);
  }
  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** Check 1 — 跨 bounded context 的 Prisma model 访问 (写禁 / 读需 CROSS-CONTEXT-READ)。 */
function checkDataMoat(
  sf: SourceFile,
  fileCtx: string | null,
  schemaAccessors: Set<string>,
  violations: Violation[],
): void {
  const filePath = sf.getFilePath();
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) continue;
    const op = callee.getName();
    if (!PRISMA_OPS.has(op)) continue;
    const inner = callee.getExpression();
    if (!Node.isPropertyAccessExpression(inner)) continue;
    const accessor = inner.getName();
    if (!schemaAccessors.has(accessor)) continue; // 非 Prisma model, 跳过

    const line = inner.getNameNode().getStartLineNumber();
    const owner = MODEL_OWNERSHIP[accessor];
    if (!owner) {
      violations.push({
        file: filePath,
        line,
        rule: 'moat-unmapped',
        message: `Prisma model '${accessor}' 被访问但 MODEL_OWNERSHIP 未声明 owner — 接线新表时必须在 scripts/checks/check-server-moat.ts 声明其所属 context`,
      });
      continue;
    }
    if (fileCtx === owner) continue; // 自有表, 合法

    if (WRITE_OPS.has(op)) {
      violations.push({
        file: filePath,
        line,
        rule: 'moat-write',
        message: `${fileCtx} 跨 ctx **写** ${owner} 的表 '${accessor}.${op}()' — 禁; 委托 ${owner} 的 Commit*UseCase (R2, per ADR-0043 §3)`,
      });
      continue;
    }
    // 读: 允许带 // CROSS-CONTEXT-READ: 的只读逃生口 (catalog Q7-B)
    const stmt = call.getFirstAncestor((a) => Node.isStatement(a)) ?? call;
    if (!/CROSS-CONTEXT-READ\b/.test(contiguousCommentAbove(sf, stmt))) {
      violations.push({
        file: filePath,
        line,
        rule: 'moat-read',
        message: `${fileCtx} 跨 ctx **读** ${owner} 的表 '${accessor}.${op}()' 缺 // CROSS-CONTEXT-READ: 注释 (catalog Q7-B 只读逃生口) — 或优先走 Outbox replay 本地副本 (Q7-A)`,
      });
    }
  }
}

/** Check 2 — 跨业务 ctx 的构造器注入参数需 CROSS-CONTEXT-{SYNC,ASYNC,READ} 注释 (R2 / ADR-0034 Stage C)。 */
function checkInjectionAnnotations(
  sf: SourceFile,
  fileCtx: string | null,
  violations: Violation[],
): void {
  if (fileCtx === null || !BUSINESS_CTX.has(fileCtx)) return;
  const filePath = sf.getFilePath();
  for (const ctor of sf.getDescendantsOfKind(SyntaxKind.Constructor)) {
    for (const param of ctor.getParameters()) {
      const typeName = paramTypeName(param);
      if (!typeName) continue;
      const imp = sf
        .getImportDeclarations()
        .find((d) =>
          d
            .getNamedImports()
            .some((ni) => (ni.getAliasNode() ?? ni.getNameNode()).getText() === typeName),
        );
      if (!imp) continue; // 本 ctx 局部类型, 非跨 ctx
      const targetCtx = ctxOfSpecifier(filePath, imp.getModuleSpecifierValue());
      if (targetCtx === null || targetCtx === PLATFORM_CTX) continue; // 平台基座豁免
      if (targetCtx === fileCtx) continue; // 同 ctx
      if (!BUSINESS_CTX.has(targetCtx)) continue; // 仅业务 ctx 互调要求注释

      if (!/CROSS-CONTEXT-(SYNC|ASYNC|READ)\b/.test(contiguousCommentAbove(sf, param))) {
        violations.push({
          file: filePath,
          line: param.getStartLineNumber(),
          rule: 'cross-ctx-annotation',
          message: `${fileCtx} 注入跨 ctx ${targetCtx} 的 '${typeName}' 缺 // CROSS-CONTEXT-{SYNC,ASYNC,READ}: 注释 (注入点 = 行为耦合点, per ADR-0034 Stage C / R2)`,
        });
      }
    }
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────
function main(): void {
  if (!existsSync(`${SERVER_ROOT}/src`)) {
    console.log('[check-server-moat] no apps/server/src (skip)');
    process.exit(0);
  }
  const violations = scanServerMoat();
  if (violations.length === 0) {
    console.log('[check-server-moat] ✓ 0 护城河违规 (数据归属 + 跨 ctx 注入注释)');
    process.exit(0);
  }
  console.error('❌ check-server-moat: 发现护城河违规 (ADR-0043 §5 + ADR-0034 Stage C)');
  for (const v of violations) {
    const rel = v.file.replace(`${process.cwd()}/`, '');
    console.error(`   - ${rel}:${v.line} [${v.rule}] ${v.message}`);
  }
  console.error(`\n[check-server-moat] ${violations.length} violation(s)`);
  process.exit(1);
}

// tsx 直跑时执行 CLI; 被 import (测试) 时不跑。
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
