// 032 T012 — ideation 路由常量纯逻辑单测。Stack/Redirect render 留 T017/T019 e2e。
import { describe, expect, it } from 'vitest';
import {
  IDEATION_LIST_ROUTE,
  ideationImageAnnotateRoute,
  ideationImageViewerRoute,
  ideationMockupsRoute,
  ideationSessionRoute,
} from './ideation-routes';

describe('ideation 路由常量 (T012)', () => {
  it('列表根路由 = /(app)/(tabs)/ideation（灵感 tab 根屏）', () => {
    expect(IDEATION_LIST_ROUTE).toBe('/(app)/(tabs)/ideation');
  });

  it('会话详情路由拼数字串 id（建会话后 push 目标）', () => {
    expect(ideationSessionRoute('12345')).toBe('/(app)/(tabs)/ideation/12345');
  });

  it('id 含特殊形态（BigInt 序列化为长数字串）仍直拼', () => {
    expect(ideationSessionRoute('9007199254740993')).toBe(
      '/(app)/(tabs)/ideation/9007199254740993',
    );
  });

  it('图片查看器路由带 uri/index/sessionId query（036 B2-3）', () => {
    const r = ideationImageViewerRoute({ uri: 'file://a.jpg', index: '0', sessionId: '42' });
    expect(r.pathname).toBe('/(app)/(tabs)/ideation/image-viewer');
    expect(r.params).toEqual({ uri: 'file://a.jpg', index: '0', sessionId: '42' });
  });

  it('标注画布路由同参数透传', () => {
    const r = ideationImageAnnotateRoute({ uri: 'content://x', index: '2', sessionId: '7' });
    expect(r.pathname).toBe('/(app)/(tabs)/ideation/image-annotate');
    expect(r.params).toEqual({ uri: 'content://x', index: '2', sessionId: '7' });
  });

  it('设计稿区路由带 sessionId query（037 mockup 渲染）', () => {
    const r = ideationMockupsRoute({ sessionId: '42' });
    expect(r.pathname).toBe('/(app)/(tabs)/ideation/mockups');
    expect(r.params).toEqual({ sessionId: '42' });
  });
});
