import { useQuoteMerge } from '~/portfolio/use-quote-merge';
import { QuoteStrip } from './quote-strip';

// 行情条 connected wrapper（屏 1/2/3 共用）：名称 + 行情同走 015 quote client merge
// （/quote 已返 name，原 014 detail 取名退役），喂 presentational QuoteStrip。
// 未就位 → '--' 占位（QuoteStrip 兜底）。

export interface InstrumentQuoteStripProps {
  market: string;
  code: string;
}

export function InstrumentQuoteStrip({ market, code }: InstrumentQuoteStripProps) {
  const { quoteFor } = useQuoteMerge([{ market, code }]);
  const quote = quoteFor({ market, code });

  return <QuoteStrip name={quote?.name ?? '--'} code={code} quote={quote} />;
}
