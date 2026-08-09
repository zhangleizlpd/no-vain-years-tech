import { describe, it, expect } from 'vitest';
import {
  AVAILABLE_MODEL_IDS,
  CHAT_MODELS,
  ListModelsUseCase,
  type ModelMeta,
} from './list-models.usecase';

/**
 * 029 T001 模型元数据 UC — 纯逻辑 (常量派生, 无 DB)。
 * 验: 返 3 项 / flash·pro available 且 minimax 不可用 / id·label·description 字段齐。
 */
describe('029 ListModelsUseCase (常量派生, 无 DB)', () => {
  const uc = new ListModelsUseCase();

  it('返回 3 项模型', () => {
    expect(uc.execute().models).toHaveLength(3);
  });

  it('flash / pro / minimax 均可用', () => {
    const byId = new Map(uc.execute().models.map((m) => [m.id, m]));
    expect(byId.get('flash')?.available).toBe(true);
    expect(byId.get('pro')?.available).toBe(true);
    expect(byId.get('minimax')?.available).toBe(true);
  });

  it('每项字段齐全 (id / label / description / available)', () => {
    for (const m of uc.execute().models) {
      expect(typeof m.id).toBe('string');
      expect(m.id.length).toBeGreaterThan(0);
      expect(typeof m.label).toBe('string');
      expect(m.label.length).toBeGreaterThan(0);
      expect(typeof m.description).toBe('string');
      expect(m.description.length).toBeGreaterThan(0);
      expect(typeof m.available).toBe('boolean');
    }
  });

  it('id 命名锁定 flash / pro / minimax (与 mobile + provider 映射一致)', () => {
    expect(uc.execute().models.map((m) => m.id)).toEqual(['flash', 'pro', 'minimax']);
  });

  it('flash「快速」/ pro「思考」label + 描述符合 plan D2', () => {
    const byId = new Map(uc.execute().models.map((m) => [m.id, m]));
    expect(byId.get('flash')).toMatchObject<Partial<ModelMeta>>({
      label: '快速',
      description: '响应迅速，适合日常问答',
    });
    expect(byId.get('pro')).toMatchObject<Partial<ModelMeta>>({
      label: '思考',
      description: '深度推理，适合复杂问题',
    });
    expect(byId.get('minimax')).toMatchObject<Partial<ModelMeta>>({
      label: 'MiniMax',
      description: '海螺 M3，长上下文通用',
    });
  });

  it('AVAILABLE_MODEL_IDS 派生自 available 项 (= [flash, pro, minimax], 值域校验单源)', () => {
    expect([...AVAILABLE_MODEL_IDS]).toEqual(['flash', 'pro', 'minimax']);
  });

  it('execute() 返回浅拷贝 — 不暴露/可变 CHAT_MODELS 共享常量', () => {
    const first = uc.execute().models;
    first[0]!.label = 'MUTATED';
    // 再取一次不受上次 mutate 影响 (各次浅拷贝独立; 源常量未被改)。
    expect(uc.execute().models[0]!.label).toBe('快速');
    expect(CHAT_MODELS[0]!.label).toBe('快速');
  });
});
