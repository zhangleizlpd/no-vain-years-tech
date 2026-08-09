import { Text, View } from 'react-native';
import type { QuoteItem } from '@nvy/api-client';

import {
  formatChange,
  formatPct,
  formatPrice,
  quoteColorClass,
  quoteDirection,
} from '~/portfolio/use-quote-merge';
import { ALERT_COPY } from './alert-copy';
import { limitPrices, prevCloseOf } from './limit-price.rules';

// 行情条（021 屏 1 顶部 / FR-M01）：左 名+代码，右 5 字段——最新价/涨跌额/涨跌幅
// （015 EP2 client-side merge，复用 ~/portfolio/use-quote-merge 格式化器，涨红跌绿）
// + 涨停/跌停（昨收×板块规则客户端纯函数，恒 up/down 色）。任一缺失 '--'。
// presentational — 格式化/涨跌停纯函数走 vitest，渲染走 Playwright（mono 测试分层）。

const COPY = ALERT_COPY.quoteStrip;

export interface QuoteStripProps {
  name: string;
  code: string;
  /** 015 merge 行情（未就位 → undefined → 全 '--'）。 */
  quote: QuoteItem | undefined;
}

export function QuoteStrip({ name, code, quote }: QuoteStripProps) {
  const colorClass = quoteColorClass(quoteDirection(quote));
  const limits = limitPrices(prevCloseOf(quote), code, name);

  return (
    <View className="flex-row items-center gap-sm bg-surface px-md py-sm border-b border-line-soft">
      <View className="w-20">
        <Text className="text-base font-semibold text-ink" numberOfLines={1}>
          {name}
        </Text>
        <Text className="text-xs font-mono text-ink-subtle">{code}</Text>
      </View>
      <Field label={COPY.last} value={formatPrice(quote)} colorClass={colorClass} />
      <Field label={COPY.change} value={formatChange(quote)} colorClass={colorClass} />
      <Field label={COPY.changePct} value={formatPct(quote)} colorClass={colorClass} />
      <Field label={COPY.limitUp} value={limits.up ?? '--'} colorClass="text-quote-up" />
      <Field label={COPY.limitDown} value={limits.down ?? '--'} colorClass="text-quote-down" />
    </View>
  );
}

/** 单字段：值上（mono 等宽）label 下（屏 5 组头同口径复用）。 */
function Field({ label, value, colorClass }: { label: string; value: string; colorClass: string }) {
  return (
    <View className="flex-1 items-center">
      <Text className={`text-sm font-mono font-semibold ${colorClass}`} numberOfLines={1}>
        {value}
      </Text>
      <Text className="text-xs text-ink-subtle mt-0.5">{label}</Text>
    </View>
  );
}
