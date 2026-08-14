// 055 T015 — 报表入口与深链闸的单测（Small，logic-only）。
//
// 🚨 本文件的主判据是 **`FR-037a` 两个落点共读同一份判据**，以及那份判据在
//    「锚在不在还不知道」上**蓄意不对称**：入口不给（fail-closed）、报表不拦（fail-open）。
//    两边都写成同一个方向，屏上都渲染得出来 —— 一个是加载期闪一下的入口，一个是把读故障
//    说成「你还没建锚」，两者都不会红。
import { describe, expect, it } from 'vitest';

import {
  chainReportAnchorPresence,
  chainReportBlocksReport,
  chainReportEntryVisible,
} from './chain-report-entry.rules';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';

const COPY = OPTIONSDESK_COPY.chainReport;

describe('055 T015 —— 锚在不在（FR-037a 的唯一判据）', () => {
  it('明确无锚 ⇒ absent', () => {
    expect(chainReportAnchorPresence({ anchorMissing: true, anchorLoaded: false })).toBe('absent');
  });

  it('锚已到手 ⇒ present', () => {
    expect(chainReportAnchorPresence({ anchorMissing: false, anchorLoaded: true })).toBe('present');
  });

  it('还在飞 / 读挂了 ⇒ unknown（🚫 MUST NOT 兜成 absent —— 读故障不是没建锚）', () => {
    expect(chainReportAnchorPresence({ anchorMissing: false, anchorLoaded: false })).toBe(
      'unknown',
    );
  });

  it('🚨 `anchorMissing` 压过 `anchorLoaded` —— 两者同真时仍判 absent', () => {
    expect(chainReportAnchorPresence({ anchorMissing: true, anchorLoaded: true })).toBe('absent');
  });
});

describe('055 T015 —— 详情屏入口（FR-037a 前半，fail-closed）', () => {
  it('只有确知有锚才出现', () => {
    expect(chainReportEntryVisible('present')).toBe(true);
  });

  it('🚨 未建锚 ⇒ 整行不出现', () => {
    expect(chainReportEntryVisible('absent')).toBe(false);
  });

  it('🚨 还不知道 ⇒ 也不出现（给了会在加载完成后闪掉，且可能通往一个进不去的屏）', () => {
    expect(chainReportEntryVisible('unknown')).toBe(false);
  });
});

describe('055 T015 —— 报表深链闸（FR-037a 后半，fail-open）', () => {
  it('🚨 未建锚 ⇒ 拦下（改呈建锚引导，🚫 MUST NOT 渲染一张缺一角的报表）', () => {
    expect(chainReportBlocksReport('absent')).toBe(true);
  });

  it('有锚 ⇒ 放行', () => {
    expect(chainReportBlocksReport('present')).toBe(false);
  });

  it('🚨 还不知道 ⇒ 不拦（拦了等于把「还在取数 / 读挂了」说成「你还没建锚」）', () => {
    expect(chainReportBlocksReport('unknown')).toBe(false);
  });
});

describe('🚨 055 T015 —— 两个落点在 `unknown` 上蓄意不对称', () => {
  // 这条是本文件的核心：同一个 presence 上两边给出相反的答案，且这是设计而非疏漏。
  // 谁把两边「对齐成一致」都会当场红。
  it('不知道有没有锚时：入口不出现，而报表不拦', () => {
    expect(chainReportEntryVisible('unknown')).toBe(false);
    expect(chainReportBlocksReport('unknown')).toBe(false);
  });

  it('三种 presence 上，两个判据不是同一个函数（存在至少一处答案相反）', () => {
    const presences = ['present', 'absent', 'unknown'] as const;
    const diverging = presences.filter(
      (p) => chainReportEntryVisible(p) === chainReportBlocksReport(p),
    );
    // present: true/false · absent: false/true · unknown: false/false ⇒ 只有 unknown 一处相同
    expect(diverging).toEqual(['unknown']);
  });
});

describe('🚨 055 T015 —— 入口措辞不与温度计入口重复（FR-037）', () => {
  const panorama = OPTIONSDESK_COPY.underlyingDetail.ivBlock.panorama;

  it('主标题不含 046 已占用的「全景」', () => {
    expect(COPY.entryTitle).not.toContain('全景');
  });

  it('同一屏上两个入口的措辞互异（撞名 = 文案相同、目的地不同）', () => {
    expect(new Set([panorama, COPY.entryTitle]).size).toBe(2);
  });

  it('副标题说的是「看什么」而不是复述主标题', () => {
    expect(COPY.entrySubtitle.length).toBeGreaterThan(0);
    expect(COPY.entrySubtitle).not.toBe(COPY.entryTitle);
  });
});
