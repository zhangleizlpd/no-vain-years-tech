// 037 T010 — mockup 隔离渲染纯逻辑单测（URL/origin/CSP/导航放行）。
// 渲染组件本身（WebView/iframe render + 拦截真触发）= T013 Playwright Web e2e；本测只锁纯函数。
import { describe, expect, it } from 'vitest';

import {
  buildCspMetaContent,
  deriveOriginWhitelist,
  isNavigationAllowed,
  isRenderableMockupUrl,
  originOf,
} from './mockup-render.rules';

const BASE = 'https://mockup.example.com';
const ALLOWED = [BASE];

describe('originOf', () => {
  it('取 https origin（去 path/query/hash）', () => {
    expect(originOf('https://mockup.example.com/a/b.html?x=1#h')).toBe(
      'https://mockup.example.com',
    );
  });

  it('保留显式端口', () => {
    expect(originOf('http://host:8080/p')).toBe('http://host:8080');
  });

  it('host 归一化为小写', () => {
    expect(originOf('https://Mockup.Example.COM/p')).toBe('https://mockup.example.com');
  });

  it('非 http(s) scheme → null（data/file/about/javascript）', () => {
    expect(originOf('data:text/html,<h1>x</h1>')).toBeNull();
    expect(originOf('file:///etc/passwd')).toBeNull();
    expect(originOf('javascript:alert(1)')).toBeNull();
    expect(originOf('about:blank')).toBeNull();
  });

  it('空串 / 垃圾 → null', () => {
    expect(originOf('')).toBeNull();
    expect(originOf('not a url')).toBeNull();
  });
});

describe('deriveOriginWhitelist', () => {
  it('配置了备案域 → 返该 origin 单元素数组', () => {
    expect(deriveOriginWhitelist(BASE)).toEqual([BASE]);
  });

  it('base 带 path → 仅取 origin', () => {
    expect(deriveOriginWhitelist('https://mockup.example.com/oss-prefix')).toEqual([BASE]);
  });

  it('base 未配（空串）→ 空数组（无放行 origin）', () => {
    expect(deriveOriginWhitelist('')).toEqual([]);
  });

  it('base 非法 → 空数组', () => {
    expect(deriveOriginWhitelist('garbage')).toEqual([]);
  });
});

describe('isNavigationAllowed（喂 onShouldStartLoadWithRequest，拦外链）', () => {
  it('备案域同 origin 导航 → 放行', () => {
    expect(isNavigationAllowed('https://mockup.example.com/v1/index.html', ALLOWED)).toBe(true);
  });

  it('任意外链（他域）→ 拒', () => {
    expect(isNavigationAllowed('https://evil.example.com/steal', ALLOWED)).toBe(false);
  });

  it('同 host 但 scheme 降级（http）→ 拒（origin 不等）', () => {
    expect(isNavigationAllowed('http://mockup.example.com/x', ALLOWED)).toBe(false);
  });

  it('data: / javascript: 伪协议跳转 → 拒', () => {
    expect(isNavigationAllowed('data:text/html,<script>1</script>', ALLOWED)).toBe(false);
    expect(isNavigationAllowed('javascript:alert(document.cookie)', ALLOWED)).toBe(false);
  });

  it('放行列表为空（备案域未配）→ 一切导航拒', () => {
    expect(isNavigationAllowed('https://mockup.example.com/x', [])).toBe(false);
  });
});

describe('isRenderableMockupUrl（server 派生 URL 可渲染判定）', () => {
  it('备案域下的非空 URL → 可渲染', () => {
    expect(isRenderableMockupUrl('https://mockup.example.com/m/1.html', ALLOWED)).toBe(true);
  });

  it('null（OSS 未配，server 返 null）→ 不可渲染（走降级）', () => {
    expect(isRenderableMockupUrl(null, ALLOWED)).toBe(false);
    expect(isRenderableMockupUrl(undefined, ALLOWED)).toBe(false);
  });

  it('空串 → 不可渲染', () => {
    expect(isRenderableMockupUrl('', ALLOWED)).toBe(false);
  });

  it('非备案域脏 URL → 不可渲染（即使非空）', () => {
    expect(isRenderableMockupUrl('https://evil.example.com/x.html', ALLOWED)).toBe(false);
  });
});

describe('buildCspMetaContent', () => {
  it('default-src 全禁 + 无 script-src（禁脚本，呼应 JS-off）', () => {
    const csp = buildCspMetaContent(BASE);
    expect(csp).toContain(`default-src 'none'`);
    expect(csp).not.toContain('script-src');
  });

  it('禁表单外发（form-action none）', () => {
    expect(buildCspMetaContent(BASE)).toContain(`form-action 'none'`);
  });

  it('放行备案域 origin 于 img/style/font-src（同文档内联资源）', () => {
    const csp = buildCspMetaContent(BASE);
    expect(csp).toContain(`img-src 'self' data: ${BASE}`);
    expect(csp).toContain(`style-src 'self' 'unsafe-inline' ${BASE}`);
  });

  it('备案域未配 → 不拼空 origin（无尾随空格污染指令）', () => {
    const csp = buildCspMetaContent('');
    expect(csp).toContain(`img-src 'self' data:`);
    expect(csp).not.toContain('data:  ');
  });
});
