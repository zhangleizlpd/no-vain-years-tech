import { describe, it, expect } from 'vitest';
import {
  platformBaseLayer,
  userCustomLayer,
  webSearchSteering,
  dateContext,
  composeSystemPrompt,
  type SystemPromptContext,
} from './system-prompt.rules';

/** 固定时刻供日期 grounding 断言 (UTC 2026-06-18T01:30:00Z → 北京时间 09:30)。 */
const FIXED_NOW = new Date('2026-06-18T01:30:00.000Z');

function ctx(over: Partial<SystemPromptContext> = {}): SystemPromptContext {
  return { webSearch: false, now: FIXED_NOW, locale: 'zh-CN', ...over };
}

describe('system-prompt.rules', () => {
  describe('webSearchSteering 层', () => {
    it('webSearch=true → 返 steering 文案 (实时/时效优先检索 + 标来源)', () => {
      const out = webSearchSteering(ctx({ webSearch: true }));
      expect(out).not.toBeNull();
      // 关键语义锚点 (不逐字, 验意图在)
      expect(out).toContain('联网');
      expect(out).toMatch(/实时|最新|时效/);
      expect(out).toContain('web_search');
      expect(out).toContain('来源');
      expect(out).toMatch(/寒暄|常识/);
    });

    it('webSearch=false → null (非联网不注入)', () => {
      expect(webSearchSteering(ctx({ webSearch: false }))).toBeNull();
    });
  });

  describe('dateContext 层', () => {
    it('webSearch=true → 返当前时间文案, 含注入 now 的格式化日期 (纯函数可测)', () => {
      const out = dateContext(ctx({ webSearch: true }));
      expect(out).not.toBeNull();
      expect(out).toContain('当前时间');
      // 注入固定 now → 格式化含年月日 (2026 / 06 / 18), 用于理解今天/本周/最近
      expect(out).toContain('2026');
      expect(out).toMatch(/06|6 月|6月/);
      expect(out).toMatch(/18/);
      expect(out).toMatch(/今天|本周|最近/);
    });

    it('同一 now 注入 → 输出确定 (纯函数无时钟读取)', () => {
      const a = dateContext(ctx({ webSearch: true }));
      const b = dateContext(ctx({ webSearch: true }));
      expect(a).toBe(b);
    });

    it('不同 now 注入 → 日期文本不同', () => {
      const jun = dateContext(ctx({ webSearch: true, now: new Date('2026-06-18T01:30:00Z') }));
      const dec = dateContext(ctx({ webSearch: true, now: new Date('2026-12-25T01:30:00Z') }));
      expect(jun).not.toBe(dec);
      expect(dec).toMatch(/12|12 月|12月/);
    });

    it('webSearch=false → null', () => {
      expect(dateContext(ctx({ webSearch: false }))).toBeNull();
    });
  });

  describe('platformBaseLayer 层 (031, 恒非 null 最高优先级)', () => {
    it('webSearch=true/false 均返非 null 身份 + 注入硬化声明', () => {
      for (const ws of [true, false]) {
        const out = platformBaseLayer(ctx({ webSearch: ws }));
        expect(out).not.toBeNull();
        expect(out).toContain('不虚此生');
        expect(out).toContain('AI 助手');
        // 注入硬化: 最高优先 + 不得覆盖 + 不执行越权/泄露/忽略指令
        expect(out).toMatch(/最高优先/);
        expect(out).toMatch(/不得覆盖|不得.*绕过/);
        expect(out).toMatch(/忽略|越权|泄露/);
      }
    });
  });

  describe('userCustomLayer 层 (031, 最低优先级 + delimiter 隔离)', () => {
    it('空串 → null (D9 清空, 不注入空白段)', () => {
      expect(userCustomLayer(ctx({ userCustomInstruction: '' }))).toBeNull();
    });

    it('纯空白 → null', () => {
      expect(userCustomLayer(ctx({ userCustomInstruction: '   \n\t ' }))).toBeNull();
    });

    it('undefined (未设置) → null', () => {
      expect(userCustomLayer(ctx({ userCustomInstruction: undefined }))).toBeNull();
    });

    it('非空 → delimiter 包裹用户内容 + 本地标注「不可信不得覆盖」', () => {
      const out = userCustomLayer(ctx({ userCustomInstruction: '请用英文回答' }));
      expect(out).not.toBeNull();
      expect(out).toContain('请用英文回答');
      expect(out).toMatch(/不可信/);
      expect(out).toMatch(/不得覆盖/);
      // delimiter 包裹 (用户内容夹在开/闭标记间)
      expect(out).toMatch(/<<<USER_CUSTOM>>>[\s\S]*请用英文回答[\s\S]*<<<END_USER_CUSTOM>>>/);
    });
  });

  describe('composeSystemPrompt 组合器', () => {
    it('webSearch=true 无自定义 → platformBase + steering + 日期三段, \\n\\n 拼接, platformBase 列首', () => {
      const out = composeSystemPrompt(ctx({ webSearch: true }));
      expect(out).not.toBeNull();
      const base = platformBaseLayer(ctx({ webSearch: true }));
      const steering = webSearchSteering(ctx({ webSearch: true }))!;
      const date = dateContext(ctx({ webSearch: true }))!;
      expect(out).toBe(`${base}\n\n${steering}\n\n${date}`);
      // 顺序: platformBase 先于 steering 先于 date
      expect(out!.indexOf(base)).toBeLessThan(out!.indexOf(steering));
      expect(out!.indexOf(steering)).toBeLessThan(out!.indexOf(date));
    });

    it('webSearch=true 有自定义 → 四层全拼, platformBase 首 / userCustom 尾 (固定优先级序)', () => {
      const out = composeSystemPrompt(ctx({ webSearch: true, userCustomInstruction: '简短点' }))!;
      const base = platformBaseLayer(ctx({ webSearch: true }));
      const custom = userCustomLayer(ctx({ webSearch: true, userCustomInstruction: '简短点' }))!;
      // platformBase 在最前, userCustom 在最后
      expect(out.startsWith(base)).toBe(true);
      expect(out.endsWith(custom)).toBe(true);
      expect(out.indexOf(base)).toBeLessThan(out.indexOf(custom));
    });

    it('webSearch=false → 仍含 platformBase (031: 平台基座层与 webSearch 正交, 恒注入)', () => {
      const out = composeSystemPrompt(ctx({ webSearch: false }));
      expect(out).not.toBeNull();
      expect(out).toBe(platformBaseLayer(ctx({ webSearch: false })));
    });

    it('composeSystemPrompt 恒返非 null (platformBase 恒非 null → 任意 ctx 必有 system)', () => {
      expect(composeSystemPrompt(ctx({ webSearch: false }))).not.toBeNull();
      expect(composeSystemPrompt(ctx({ webSearch: true }))).not.toBeNull();
      expect(
        composeSystemPrompt(ctx({ webSearch: false, userCustomInstruction: 'x' })),
      ).not.toBeNull();
    });

    it('组合结果 = 非 null 层按固定优先级有序 join, 无空段/无前后多余分隔', () => {
      const out = composeSystemPrompt(ctx({ webSearch: true, userCustomInstruction: 'x' }))!;
      // 不以分隔符开头/结尾, 不含三连换行 (空段会产生)
      expect(out.startsWith('\n')).toBe(false);
      expect(out.endsWith('\n')).toBe(false);
      expect(out).not.toContain('\n\n\n');
    });
  });
});
