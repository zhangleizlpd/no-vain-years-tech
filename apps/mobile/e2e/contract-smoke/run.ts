/**
 * 契约冒烟套件 orchestrator — 每 feature 一条真全链路 happy-path（生成客户端 → 真 server →
 * 真落库）的单次-boot 共享 runner。
 *
 * 补测试分层的结构性盲区：没有任何层用「真实生成的 @nvy/api-client」打「真实 server」验
 * 「某 feature 核心写入端到端 + 真落库」（server IT 不经生成客户端;hermetic Playwright mock
 * 即假设契约;runtime-smoke 不做鉴权业务调用）。核心目的 = 契约对齐 + 基建,非 UI 点通。
 *
 * 共享 boot：复用 real-backend-harness 的 bootRealBackend（testcontainers + 真 server +
 * 程序化登录拿真 token）—— boot 一次,顺序跑所有 *.contract.ts 的 run(ctx),boot 成本摊销。
 * 扩展即在 SPECS 加一行（新 feature 加一个薄 *.contract.ts）。
 *
 * 不引 vitest（worker 进程模型难共享 live server 句柄）—— 风格对齐 scripts/ci/
 * server-boot-smoke.ts：node:assert + 自管 pass/fail + exit code。
 *
 * Env-gated（同 RUN_REAL_BACKEND_SMOKE）：无 Docker 裸跑 exit 0,不挂。CI 进 nightly
 * e2e-real-backend.yml 软信号（失败开 issue,不拦 merge）。本地 feature 收尾手动跑作 PR2 门。
 */
import { bootRealBackend, type RealBackendCtx } from '../_support/real-backend-harness';
import * as optionsdeskIntradayLegQuotes from './064-intraday-leg-quotes.contract';
import * as optionsdeskTwoStageRecall from './068-two-stage-recall.contract';
import * as alert from './alert.contract';
import * as alertIndicators from './alert-indicators.contract';
import * as alertPush from './alert-push.contract';
import * as alertRealtime from './alert-realtime.contract';
import * as brokerAccount from './broker-account.contract';
import * as chatCustomInstructions from './chat-custom-instructions.contract';
import * as chatHistory from './chat-history.contract';
import * as chatModelSwitch from './chat-model-switch.contract';
import * as chatStreaming from './chat-streaming.contract';
import * as chatWebSearch from './chat-web-search.contract';
import * as ideation from './ideation.contract';
import * as ideationAsr from './ideation-asr.contract';
import * as ideationGrounding from './ideation-grounding.contract';
import * as ideationImage from './ideation-image.contract';
import * as ideationMockup from './ideation-mockup.contract';
import * as marketdata from './marketdata.contract';
import * as optionsdesk from './optionsdesk.contract';
import * as optionsdeskChainLegPicker from './optionsdesk-chain-leg-picker.contract';
import * as optionsdeskChainReport from './optionsdesk-chain-report.contract';
import * as optionsdeskDetailThermometer from './optionsdesk-detail-thermometer.contract';
import * as optionsdeskRealtimeSpot from './optionsdesk-realtime-spot.contract';
import * as portfolioHoldings from './portfolio-holdings.contract';
import * as stockDetail from './stock-detail.contract';
import * as watchlist from './watchlist.contract';

interface ContractSpec {
  readonly name: string;
  run(ctx: RealBackendCtx): Promise<void>;
}

// 每 feature 一行（新 feature → 新 *.contract.ts → 在此注册）。
// portfolioHoldings 殿后：import-only（V1 无删除端点）不清理持仓表，避免影响前序 spec。
const SPECS: readonly ContractSpec[] = [
  brokerAccount,
  watchlist,
  stockDetail,
  alert,
  alertIndicators,
  alertPush,
  alertRealtime,
  marketdata,
  chatStreaming,
  chatHistory,
  chatModelSwitch,
  chatWebSearch,
  chatCustomInstructions,
  ideation,
  ideationGrounding,
  ideationAsr,
  ideationImage,
  ideationMockup,
  optionsdesk,
  optionsdeskDetailThermometer,
  optionsdeskChainLegPicker,
  optionsdeskChainReport,
  optionsdeskRealtimeSpot,
  optionsdeskIntradayLegQuotes,
  optionsdeskTwoStageRecall,
  portfolioHoldings,
];

const GATE = 'RUN_REAL_BACKEND_SMOKE';
if (process.env[GATE] !== 'true') {
  console.log(`[contract-smoke] ${GATE} !== 'true' — skipping (env-gated 独立 job).`);
  process.exit(0);
}

async function main(): Promise<number> {
  const ctx = await bootRealBackend();
  let failed = 0;
  try {
    for (const spec of SPECS) {
      try {
        console.log(`[contract-smoke] ▶ ${spec.name}`);
        await spec.run(ctx);
        console.log(`[contract-smoke] ✅ ${spec.name}`);
      } catch (e) {
        failed += 1;
        console.error(`[contract-smoke] ❌ ${spec.name}:`, e);
      }
    }
  } finally {
    await ctx.teardown();
  }
  console.log(`[contract-smoke] done — ${SPECS.length - failed}/${SPECS.length} passed`);
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[contract-smoke] FATAL:', err);
    process.exit(1);
  });
