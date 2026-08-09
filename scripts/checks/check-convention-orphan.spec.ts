import { describe, expect, it } from 'vitest';
import { findOrphans } from './check-convention-orphan';

describe('check-convention-orphan — 可达性判定（纯函数，无磁盘 I/O）', () => {
  it('被 CLAUDE.md 引用 → 非孤儿', () => {
    expect(findOrphans(['testing.md'], { 'CLAUDE.md': '… docs/conventions/testing.md …' })).toEqual(
      [],
    );
  });

  it('被 .claude/rules 引用 → 非孤儿', () => {
    expect(
      findOrphans(['golden-sample-registry.md'], {
        '.claude/rules/x.md': '见 golden-sample-registry.md',
      }),
    ).toEqual([]);
  });

  it('被兄弟 convention 引用 → 非孤儿', () => {
    expect(
      findOrphans(['versioning.md'], {
        'docs/conventions/git-workflow.md': '见 [versioning.md](versioning.md)',
      }),
    ).toEqual([]);
  });

  it('全仓零引用 → 孤儿', () => {
    expect(
      findOrphans(['orphan.md'], {
        'CLAUDE.md': '不提它',
        '.claude/rules/x.md': '也不提',
      }),
    ).toEqual(['orphan.md']);
  });

  it('自引用不算 rescue（只有自己提自己名字仍是孤儿）', () => {
    expect(
      findOrphans(['self-ref.md'], {
        'docs/conventions/self-ref.md': '本文件 self-ref.md 的正文',
      }),
    ).toEqual(['self-ref.md']);
  });

  it('多份混合：只报真孤儿，顺序保持', () => {
    expect(
      findOrphans(['a.md', 'b.md', 'c.md'], {
        'CLAUDE.md': '引用 a.md',
        'docs/conventions/c.md': '引用 b.md',
        'docs/conventions/b.md': '只自嗨 b.md',
      }),
    ).toEqual(['c.md']);
  });
});
