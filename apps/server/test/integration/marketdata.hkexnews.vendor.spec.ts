import { describe, it, expect } from 'vitest';
import { VendorHttpClient } from '../../src/marketdata/vendor-http-client';
import { HKEXNEWS_PROFILE } from '../../src/marketdata/hkexnews.constraint-profile';
import { HKEX_BOARD_MEETING_LIST_URL } from '../../src/marketdata/hkex-board-meeting-list.source';
import { parseBoardMeetingList } from '../../src/marketdata/hkex-board-meeting-list.rules';

/**
 * 港交所「董事會會議通知」清单真 vendor IT (079 T012, plan §D12, env-gated, 默认 skip)。
 *
 * 目的: 打真 `www3.hkexnews.hk` 取**当日页**, 校真 Small spec 的 fixture 覆盖不到的两件事 ——
 * ① 该地址当前**不跳转** (来源带 `redirect: 'manual'`, 一旦换地址这里就是 `VendorHttpError 3xx`);
 * ② 当日页仍过得了解析纯函数的全部结构不变量 (页首日期 / 表头 / 每行 6 格)。
 *
 * ⚠️ 门恒 skip ⇒ 「测试全绿」对真页面结构**不构成证据**; 改版只会在这里或 prod 运行时暴露。
 *
 * 本地启用 (公开页, 无凭据):
 *   RUN_MARKETDATA_IT=true pnpm nx test server test/integration/marketdata.hkexnews.vendor.spec.ts
 */
const RUN_MARKETDATA_IT = process.env.RUN_MARKETDATA_IT === 'true';

describe.skipIf(!RUN_MARKETDATA_IT)(
  '港交所董事會會議通知清单真 vendor IT (env-gated, 默认 skip)',
  () => {
    it('当日页: redirect manual 下取到 + 过解析纯函数 (0 行静默丢弃)', async () => {
      const html = await new VendorHttpClient(HKEXNEWS_PROFILE).requestText({
        url: HKEX_BOARD_MEETING_LIST_URL,
        method: 'GET',
        redirect: 'manual',
      });
      const page = parseBoardMeetingList(html);

      expect(page.pageDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(page.counts.dataRows).toBeGreaterThan(0);
      expect(page.counts.resultRows + page.counts.dividendOnlyRows).toBe(page.counts.dataRows);
      console.log(`[079 T012] 页首日期 ${page.pageDate} counts=${JSON.stringify(page.counts)}`);
    }, 120_000);
  },
);
