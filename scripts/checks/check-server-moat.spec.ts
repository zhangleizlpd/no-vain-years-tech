import { describe, expect, it } from 'vitest';
import { Project, type SourceFile } from 'ts-morph';
import { scanSourceFiles } from './check-server-moat';

/**
 * 真 Prisma model 锚集合 (生产由 readSchemaAccessors 从 schema.prisma 解析)。
 * account → owner account, outboxEvent → owner security (内部 MODEL_OWNERSHIP);
 * credential ∈ schema 但**未声明 owner** → 触发 moat-unmapped。
 */
const SCHEMA = new Set(['account', 'outboxEvent', 'credential']);

/** 把 {path: content} 喂进 in-memory ts-morph,返回 SourceFile[]。 */
function mk(files: Record<string, string>): SourceFile[] {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [path, content] of Object.entries(files)) project.createSourceFile(path, content);
  return project.getSourceFiles();
}

const rules = (sf: SourceFile[]) => scanSourceFiles(sf, SCHEMA).map((v) => v.rule);

describe('check-server-moat — Check 1 数据护城河', () => {
  it('同 ctx 访问自有表 → 0 违规', () => {
    const sf = mk({
      '/apps/server/src/account/a.usecase.ts': `
        class A { constructor(private prisma: any) {}
          run() { return this.prisma.account.findUnique({ where: { id: 1 } }); } }`,
    });
    expect(scanSourceFiles(sf, SCHEMA)).toHaveLength(0);
  });

  it('跨 ctx 写他表 → moat-write (无逃生口)', () => {
    const sf = mk({
      '/apps/server/src/auth/a.usecase.ts': `
        class A { run(tx: any) { return tx.account.create({ data: {} }); } }`,
    });
    expect(rules(sf)).toEqual(['moat-write']);
  });

  it('跨 ctx 读他表无注释 → moat-read', () => {
    const sf = mk({
      '/apps/server/src/auth/a.usecase.ts': `
        class A { constructor(private prisma: any) {}
          run() { return this.prisma.account.findMany(); } }`,
    });
    expect(rules(sf)).toEqual(['moat-read']);
  });

  it('跨 ctx 读他表带 // CROSS-CONTEXT-READ → 放行', () => {
    const sf = mk({
      '/apps/server/src/auth/a.usecase.ts': `
        class A { constructor(private prisma: any) {}
          run() {
            // CROSS-CONTEXT-READ: 临时只读副本 (Q7-B)
            return this.prisma.account.findMany();
          } }`,
    });
    expect(scanSourceFiles(sf, SCHEMA)).toHaveLength(0);
  });

  it('访问未声明 owner 的 model → moat-unmapped (即便在任意 ctx)', () => {
    const sf = mk({
      '/apps/server/src/security/a.ts': `
        class A { constructor(private prisma: any) {}
          run() { return this.prisma.credential.create({ data: {} }); } }`,
    });
    expect(rules(sf)).toEqual(['moat-unmapped']);
  });

  it('outboxEvent 在 security 自有 → 0;数组 .find() 等非 Prisma op 不误报', () => {
    const sf = mk({
      '/apps/server/src/security/outbox/p.ts': `
        class P { constructor(private prisma: any) {}
          run(arr: number[]) { arr.find((x) => x > 0); return this.prisma.outboxEvent.findMany(); } }`,
    });
    expect(scanSourceFiles(sf, SCHEMA)).toHaveLength(0);
  });
});

describe('check-server-moat — Check 2 跨业务 ctx 注入注释', () => {
  it('auth 注入 account UseCase 缺注释 → cross-ctx-annotation', () => {
    const sf = mk({
      '/apps/server/src/auth/a.usecase.ts': `
        import { InspectAccountStatusUseCase } from '../account/inspect-account-status.usecase';
        class A { constructor(private readonly inspect: InspectAccountStatusUseCase) {} }`,
    });
    expect(rules(sf)).toEqual(['cross-ctx-annotation']);
  });

  it('auth 注入 account UseCase 带 // CROSS-CONTEXT-SYNC → 放行', () => {
    const sf = mk({
      '/apps/server/src/auth/a.usecase.ts': `
        import { InspectAccountStatusUseCase } from '../account/inspect-account-status.usecase';
        class A {
          constructor(
            // CROSS-CONTEXT-SYNC: auth → account 读状态
            private readonly inspect: InspectAccountStatusUseCase,
          ) {}
        }`,
    });
    expect(scanSourceFiles(sf, SCHEMA)).toHaveLength(0);
  });

  it('注入 security 平台基座 (PrismaService) → 无注释要求 (豁免)', () => {
    const sf = mk({
      '/apps/server/src/auth/a.usecase.ts': `
        import { PrismaService } from '../security/prisma.service';
        class A { constructor(private readonly prisma: PrismaService) {} }`,
    });
    expect(scanSourceFiles(sf, SCHEMA)).toHaveLength(0);
  });

  it('同 ctx 注入 (account 注入 account) → 无注释要求', () => {
    const sf = mk({
      '/apps/server/src/account/a.usecase.ts': `
        import { CommitPhoneLoginUseCase } from './commit-phone-login.usecase';
        class A { constructor(private readonly commit: CommitPhoneLoginUseCase) {} }`,
    });
    expect(scanSourceFiles(sf, SCHEMA)).toHaveLength(0);
  });

  it('纯函数 / 异常 import (非构造器注入) → 不在扫描面', () => {
    const sf = mk({
      '/apps/server/src/auth/c.controller.ts': `
        import { normalizePhone } from '../account/account.rules';
        import { AccountInFreezePeriodException } from '../account/account-in-freeze-period.exception';
        class C { run(p: string) { normalizePhone(p); throw new AccountInFreezePeriodException(new Date()); } }`,
    });
    expect(scanSourceFiles(sf, SCHEMA)).toHaveLength(0);
  });
});
