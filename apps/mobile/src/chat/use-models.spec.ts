// 029 T006 — 模型清单 hook 纯逻辑单测（vitest=logic，per 测试分层）。
// hook 编排（useQuery / loading / error 态）走 Playwright + contract-smoke；本文件只测可
// 单测纯逻辑：端点正常返清单 → 直出；端点失败 / loading → 降级内置默认（FR-012）；
// available 标记透传（留位项 disabled）。mock @nvy/api-client（dist entry 在 vitest
// 不可解析；runtime hook 仅编排不触达纯函数）。
import { describe, expect, it, vi } from 'vitest';
import type { ModelListResponse } from '@nvy/api-client';

vi.mock('@nvy/api-client', () => ({
  useConversationControllerListAvailableModels: vi.fn(),
}));

import { DEFAULT_MODELS, resolveModels } from './use-models';

describe('DEFAULT_MODELS — 内置降级清单（FR-012）', () => {
  it('含 flash / pro / minimax 三项且均 available（端点失败兜底，不阻塞对话）', () => {
    const ids = DEFAULT_MODELS.map((m) => m.id);
    expect(ids).toContain('flash');
    expect(ids).toContain('pro');
    expect(ids).toContain('minimax');
    for (const m of DEFAULT_MODELS) {
      expect(m.available).toBe(true);
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.description.length).toBeGreaterThan(0);
    }
  });
});

describe('resolveModels — 端点清单 → 下拉渲染清单', () => {
  const serverList: ModelListResponse = {
    models: [
      { id: 'flash', label: '快速', description: '响应快', available: true },
      { id: 'pro', label: '思考', description: '深度推理', available: true },
      { id: 'minimax', label: 'MiniMax', description: '海螺 M3', available: true },
      // 留位项泛例（available:false）：验 resolveModels 原样透传 available 标记供 UI 置灰。
      { id: 'placeholder', label: '占位', description: '即将上线', available: false },
    ],
  };

  it('端点正常返清单 → 直出（保留 available 标记，留位项 disabled 透传）', () => {
    const models = resolveModels(serverList, false, false);
    expect(models.map((m) => m.id)).toEqual(['flash', 'pro', 'minimax', 'placeholder']);
    expect(models.find((m) => m.id === 'minimax')?.available).toBe(true);
    expect(models.find((m) => m.id === 'placeholder')?.available).toBe(false);
    expect(models.find((m) => m.id === 'flash')?.available).toBe(true);
  });

  it('端点失败 → 降级内置默认（FR-012，不阻塞对话）', () => {
    expect(resolveModels(undefined, false, true)).toEqual(DEFAULT_MODELS);
  });

  it('loading 中（尚无数据） → 降级内置默认（首屏不白屏）', () => {
    expect(resolveModels(undefined, true, false)).toEqual(DEFAULT_MODELS);
  });

  it('端点返空 models → 降级内置默认（不给空下拉）', () => {
    expect(resolveModels({ models: [] }, false, false)).toEqual(DEFAULT_MODELS);
  });
});
