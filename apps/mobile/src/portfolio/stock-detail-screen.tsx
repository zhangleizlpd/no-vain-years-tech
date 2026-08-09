import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useMarketdataControllerDetail } from '@nvy/api-client';

import { Button, ErrorRow, SafeAreaView, Spinner } from '~/ui';
import { AnalysisTab } from './analysis-tab';
import { BottomBar } from './bottom-bar';
import { ChartTab } from './chart-tab';
import { EditGroupsSheet } from './edit-groups-sheet';
import { CompanyTab } from './company-tab';
import { DetailTabs, type DetailTab } from './detail-tabs';
import { DetailTopNav } from './detail-top-nav';
import { STOCK_DETAIL_COPY } from './stock-detail-copy';

// 详情页编排骨架（014 US3 / FR-M01）。富途式：固定顶 [nav + 3-Tab] / 单 scroll 正文（按 Tab）/
// 固定底栏（T012）。报价属图表 Tab 内容（非跨 Tab 常驻）；切公司/分析或图表滚过报价 → nav condensed
// 现价（D5）。详情/K线/报价 mobile 直调 015 EP3/EP4 client-side merge（ADR-0048，server 零跨 ctx）。
// 各 Tab 正文 T008(报价+K线)/T011(公司)/T014(分析) 增量接入。presentational —— 走 Playwright e2e。

const CONDENSE_SCROLL_Y = 150; // D5：图表 Tab 滚过报价阈值。

export interface StockDetailScreenProps {
  market: string;
  code: string;
}

export function StockDetailScreen({ market, code }: StockDetailScreenProps) {
  const symbol = `${market}:${code}`;
  const detailQuery = useMarketdataControllerDetail(symbol);
  const detail = detailQuery.data?.data;

  const [tab, setTab] = useState<DetailTab>('chart');
  const [scrollY, setScrollY] = useState(0);
  const [editGroupsOpen, setEditGroupsOpen] = useState(false); // T013 EditGroupsSheet 开关。
  // D5：非图表 Tab 恒 condensed；图表 Tab 滚过报价(>150) → condensed。
  const condensed = tab !== 'chart' || scrollY > CONDENSE_SCROLL_Y;

  const body = detailQuery.isPending ? (
    <View className="items-center py-2xl">
      <Spinner />
    </View>
  ) : detailQuery.isError ? (
    <View className="items-center gap-md px-md py-2xl">
      <ErrorRow text={STOCK_DETAIL_COPY.load.error} />
      <Button label={STOCK_DETAIL_COPY.load.retry} onPress={() => void detailQuery.refetch()} />
    </View>
  ) : !detail ? null : tab === 'chart' ? (
    // 图表 Tab 正文：报价 header（T008）+ 周期/复权 + 纯 SVG K线（T010）。
    <ChartTab detail={detail} symbol={symbol} />
  ) : tab === 'company' ? (
    // 公司 Tab 正文：理杏仁 5 分区卡 + 分位条（T011）。
    <CompanyTab detail={detail} />
  ) : (
    // 分析 Tab 正文：研报容器 V1 占位空态（T014）。
    <AnalysisTab />
  );

  return (
    <SafeAreaView edges={['top']} className="flex-1 bg-surface">
      <DetailTopNav detail={detail} condensed={condensed} />
      <DetailTabs active={tab} onSelect={setTab} />
      <ScrollView
        className="flex-1 bg-surface-sunken"
        scrollEventThrottle={16}
        onScroll={(e) => setScrollY(e.nativeEvent.contentOffset.y)}
      >
        {body}
      </ScrollView>
      {/* 固定底栏（预警/笔记/加·删自选窄义/编辑分组，T012）。 */}
      <BottomBar
        market={market}
        code={code}
        editOpen={editGroupsOpen}
        onEditGroups={() => setEditGroupsOpen(true)}
      />
      {/* 编辑分组 sheet（自定义组 multi-select + 新建分组弹框，T013，全复用 013 端点）。 */}
      <EditGroupsSheet
        visible={editGroupsOpen}
        onClose={() => setEditGroupsOpen(false)}
        market={market}
        code={code}
        stockName={detail?.name}
      />
    </SafeAreaView>
  );
}
