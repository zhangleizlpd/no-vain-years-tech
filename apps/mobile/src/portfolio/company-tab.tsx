import { Text, View } from 'react-native';
import type {
  InstrumentCorporateAction,
  InstrumentDetailResponse,
  InstrumentFinancials,
  InstrumentQuoteHeader,
  InstrumentValuation,
} from '@nvy/api-client';

import { PercentileBar } from './percentile-bar';
import {
  formatFractionPct,
  formatLargeAmount,
  formatPercentValue,
  formatRatio,
  parsePercentile,
} from './stock-detail.helpers';
import { STOCK_DETAIL_COPY } from './stock-detail-copy';

// 公司 Tab（014 US5 / FR-M05）：理杏仁 5 分区卡（估值 / 估值分位 / 财务衍生 / 静态身份 / 公司行动）。
// 全来自 015 EP3 detail（valuation/financials/corporateActions/quote 52w + 身份字段）。缺字段（港美股
// 薄数据 / 无财报季 / valuation·financials 整块 null）→ 逐字段 '--' 空态。格式化逻辑落
// stock-detail.helpers（vitest）；每卡独立子组件控复杂度；presentational → Playwright e2e。

const COPY = STOCK_DETAIL_COPY.company;

// valuation/financials 整块缺失（港美股薄数据）→ 规范化为全 null 对象，子卡逐字段平铺访问
// （避免逐字段 `?.`/`??` 撑高 cyclomatic 复杂度；格式化函数对 null 已出 '--'）。
const EMPTY_VALUATION: InstrumentValuation = {
  date: '',
  peTtm: null,
  peStatic: null,
  peDynamic: null,
  pb: null,
  ps: null,
  dividendYield: null,
  marketCap: null,
  circMarketCap: null,
  pePctlY3: null,
  pePctlY5: null,
  pbPctlY3: null,
  pbPctlY5: null,
};
const EMPTY_FINANCIALS: InstrumentFinancials = {
  reportPeriod: '',
  roe: null,
  grossMargin: null,
  eps: null,
  bps: null,
};

export interface CompanyTabProps {
  detail: InstrumentDetailResponse;
}

export function CompanyTab({ detail }: CompanyTabProps) {
  return (
    <View className="bg-surface-alt px-md py-md gap-md">
      <ValuationCard val={detail.valuation} />
      <PercentileCard val={detail.valuation} />
      <FinancialsCard fin={detail.financials} />
      <IdentityCard detail={detail} quote={detail.quote} />
      <ActionsCard actions={detail.corporateActions} />
    </View>
  );
}

function ValuationCard({ val }: { val: InstrumentValuation | null }) {
  const c = COPY.valuation;
  const v = val ?? EMPTY_VALUATION;
  return (
    <Card title={COPY.cards.valuation}>
      <KV label={c.peTtm} value={formatRatio(v.peTtm, 1)} />
      <KV label={c.peStatic} value={formatRatio(v.peStatic, 1)} />
      <KV label={c.peDynamic} value={formatRatio(v.peDynamic, 1)} />
      <KV label={c.pb} value={formatRatio(v.pb)} />
      <KV label={c.ps} value={formatRatio(v.ps, 1)} />
      <KV label={c.dividendYield} value={formatPercentValue(v.dividendYield)} />
      <KV label={c.marketCap} value={formatLargeAmount(v.marketCap)} />
      <KV label={c.circMarketCap} value={formatLargeAmount(v.circMarketCap)} />
    </Card>
  );
}

function PercentileCard({ val }: { val: InstrumentValuation | null }) {
  const c = COPY.percentile;
  const v = val ?? EMPTY_VALUATION;
  return (
    <Card title={COPY.cards.percentile}>
      <PercentileBar label={c.peY5} pct={parsePercentile(v.pePctlY5)} gradientId="pct-pe5" />
      <PercentileBar label={c.peY3} pct={parsePercentile(v.pePctlY3)} gradientId="pct-pe3" />
      <PercentileBar label={c.pbY5} pct={parsePercentile(v.pbPctlY5)} gradientId="pct-pb5" />
      <PercentileBar label={c.pbY3} pct={parsePercentile(v.pbPctlY3)} gradientId="pct-pb3" />
    </Card>
  );
}

function FinancialsCard({ fin }: { fin: InstrumentFinancials | null }) {
  const c = COPY.financials;
  const f = fin ?? EMPTY_FINANCIALS;
  return (
    <Card title={COPY.cards.financials}>
      <KV label={c.roe} value={formatFractionPct(f.roe, 1)} />
      <KV label={c.grossMargin} value={formatFractionPct(f.grossMargin, 1)} />
      <KV label={c.eps} value={formatRatio(f.eps)} />
      <KV label={c.bps} value={formatRatio(f.bps)} />
    </Card>
  );
}

function IdentityCard({
  detail,
  quote,
}: {
  detail: InstrumentDetailResponse;
  quote: InstrumentQuoteHeader;
}) {
  const c = COPY.identity;
  return (
    <Card title={COPY.cards.identity}>
      <KV label={c.name} value={detail.name} />
      <KV label={c.code} value={detail.code} />
      <KV label={c.market} value={detail.market.toUpperCase()} />
      <KV label={c.type} value={detail.type} />
      <KV label={c.currency} value={detail.currency} />
      <KV
        label={c.range52w}
        value={`${formatRatio(quote.fiftyTwoWeekHigh)} / ${formatRatio(quote.fiftyTwoWeekLow)}`}
      />
    </Card>
  );
}

function ActionsCard({ actions }: { actions: InstrumentCorporateAction[] }) {
  return (
    <Card title={COPY.cards.actions}>
      {actions.length === 0 ? (
        <Text className="text-sm text-ink-subtle py-xs">{COPY.actions.empty}</Text>
      ) : (
        actions.map((a, i) => (
          <View key={`${a.exDate}-${i}`} className="flex-row justify-between py-xs">
            <Text className="text-sm text-ink-muted">{actionTypeLabel(a.type)}</Text>
            <Text className="text-sm font-mono text-ink">{a.exDate}</Text>
          </View>
        ))
      )}
    </Card>
  );
}

/** 公司行动类型 → 中文（未知类型回退原值）。 */
function actionTypeLabel(type: string): string {
  const map = COPY.actions.types as Record<string, string>;
  return map[type] ?? type;
}

/** 分区卡（标题 + 内容）。 */
function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View className="bg-surface rounded-lg p-md gap-xs">
      <Text className="text-base font-semibold text-ink mb-xs">{title}</Text>
      {children}
    </View>
  );
}

/** KV 行（label 灰左 + value mono 右；缺值 '--' 由调用方格式化产出）。 */
function KV({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row justify-between py-xs">
      <Text className="text-sm text-ink-subtle">{label}</Text>
      <Text className="text-sm font-mono text-ink">{value}</Text>
    </View>
  );
}
