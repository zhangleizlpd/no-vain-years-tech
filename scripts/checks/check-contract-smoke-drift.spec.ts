import { describe, it, expect } from 'vitest';
import {
  deriveSpecCoverage,
  analyzeContractSmokeDrift,
  type ContractSpec,
} from './check-contract-smoke-drift';

const MARKETDATA_SPEC = 'apps/mobile/e2e/contract-smoke/marketdata.contract.ts';
const IDEATION_SPEC = 'apps/mobile/e2e/contract-smoke/ideation.contract.ts';

const specs: ContractSpec[] = [
  { file: MARKETDATA_SPEC, modules: ['marketdata'], unmappedPrefixes: [] },
  { file: IDEATION_SPEC, modules: ['ideation'], unmappedPrefixes: [] },
];

describe('deriveSpecCoverage — 从 controller 前缀派生覆盖 module', () => {
  it('已知前缀 → 映射到 module, 去重', () => {
    const src = `
      import { marketdataControllerQuote, marketdataControllerDetail } from '@nvy/api-client';
    `;
    const cov = deriveSpecCoverage(MARKETDATA_SPEC, src);
    expect(cov.modules).toEqual(['marketdata']);
    expect(cov.unmappedPrefixes).toEqual([]);
  });

  it('多前缀跨 module → 收敛去重 (chatPreference + conversation → chat)', () => {
    const src = `chatPreferenceControllerGet(); conversationControllerList();`;
    expect(deriveSpecCoverage('x', src).modules).toEqual(['chat']);
  });

  it('🚨 类型名的首字母大写形归一到同一个 module —— 同一 operationId 生成两种标识符', () => {
    // orval 由同一个 operationId 生成函数 `optionsdeskControllerLegs` 与其参数类型
    // `OptionsdeskControllerLegsParams`。spec 只 `import type` 后者时不归一 ⇒ 报「未映射前缀」，
    // 而那条警告的本意是「表过期」—— 纯拼写差引发的假信号会让人去改一张本来就对的表。
    const src = `import type { OptionsdeskControllerLegsParams } from '@nvy/api-client';`;
    const cov = deriveSpecCoverage('x', src);
    expect(cov.modules).toEqual(['optionsdesk']);
    expect(cov.unmappedPrefixes).toEqual([]);
  });

  it('未映射前缀 → 进 unmappedPrefixes (表过期信号)', () => {
    const src = `fooControllerBar(); marketdataControllerQuote();`;
    const cov = deriveSpecCoverage('x', src);
    expect(cov.modules).toEqual(['marketdata']);
    expect(cov.unmappedPrefixes).toEqual(['foo']);
  });
});

describe('analyzeContractSmokeDrift — 改 module 代码却没改其 contract spec → 警告', () => {
  it('改 marketdata prod 文件 + 没动 marketdata.contract → 警告', () => {
    const changed = ['apps/server/src/marketdata/eod-backed-quote.adapter.ts'];
    const { warnings } = analyzeContractSmokeDrift(changed, specs);
    expect(warnings).toEqual([{ module: 'marketdata', specs: [MARKETDATA_SPEC] }]);
  });

  it('改 marketdata prod 文件 + 同 diff 改了 marketdata.contract → 不警告', () => {
    const changed = ['apps/server/src/marketdata/eod-backed-quote.adapter.ts', MARKETDATA_SPEC];
    expect(analyzeContractSmokeDrift(changed, specs).warnings).toEqual([]);
  });

  it('只改 module 的 .spec.ts / .it.spec.ts (测试文件) → 不算 module 改动, 不警告', () => {
    const changed = [
      'apps/server/src/marketdata/eod-backed-quote.adapter.spec.ts',
      'apps/server/src/marketdata/eod-backed-quote.adapter.it.spec.ts',
    ];
    expect(analyzeContractSmokeDrift(changed, specs).warnings).toEqual([]);
  });

  it('改无 contract 覆盖的 module (account) → 不警告', () => {
    const changed = ['apps/server/src/account/account-profile.controller.ts'];
    expect(analyzeContractSmokeDrift(changed, specs).warnings).toEqual([]);
  });

  it('非 server 改动 (mobile / docs) → 不警告', () => {
    const changed = ['apps/mobile/src/marketdata/quote.tsx', 'docs/foo.md'];
    expect(analyzeContractSmokeDrift(changed, specs).warnings).toEqual([]);
  });

  it('unmappedPrefixes 透传到 report (汇总去重)', () => {
    const withUnmapped: ContractSpec[] = [
      { file: 'x', modules: [], unmappedPrefixes: ['foo'] },
      { file: 'y', modules: [], unmappedPrefixes: ['foo', 'bar'] },
    ];
    expect(analyzeContractSmokeDrift([], withUnmapped).unmappedPrefixes).toEqual(['bar', 'foo']);
  });
});
