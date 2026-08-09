import { describe, expect, it } from 'vitest';
import { Project, type SourceFile } from 'ts-morph';
import { scanSourceFiles } from './check-api-property-nullable';

/** 把 {path: content} 喂进 in-memory ts-morph,返回 SourceFile[]。 */
function mk(files: Record<string, string>): SourceFile[] {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [path, content] of Object.entries(files)) project.createSourceFile(path, content);
  return project.getSourceFiles();
}

const fields = (sf: SourceFile[]) => scanSourceFiles(sf).map((v) => v.field);

describe('check-api-property-nullable — nullable 标量 @ApiProperty 缺 type', () => {
  it('string|null + 显式 type:string → 0 违规', () => {
    const sf = mk({
      '/apps/server/src/account/a.response.ts': `
        import { ApiProperty } from '@nestjs/swagger';
        class R {
          @ApiProperty({ nullable: true, type: 'string' })
          displayName!: string | null;
        }`,
    });
    expect(scanSourceFiles(sf)).toHaveLength(0);
  });

  it('string|null + 漏 type → 违规', () => {
    const sf = mk({
      '/apps/server/src/account/a.response.ts': `
        import { ApiProperty } from '@nestjs/swagger';
        class R {
          @ApiProperty({ nullable: true, example: 'x' })
          note!: string | null;
        }`,
    });
    expect(fields(sf)).toEqual(['note']);
  });

  it('number|null + 漏 type → 违规 (scalar=number)', () => {
    const sf = mk({
      '/apps/server/src/marketdata/a.response.ts': `
        import { ApiProperty } from '@nestjs/swagger';
        class R {
          @ApiProperty({ nullable: true })
          changePct!: number | null;
        }`,
    });
    const v = scanSourceFiles(sf);
    expect(v).toHaveLength(1);
    expect(v[0].scalar).toBe('number');
  });

  it('boolean|null + 漏 type → 违规', () => {
    const sf = mk({
      '/apps/server/src/account/a.response.ts': `
        import { ApiProperty } from '@nestjs/swagger';
        class R { @ApiProperty({ nullable: true }) flag!: boolean | null; }`,
    });
    expect(fields(sf)).toEqual(['flag']);
  });

  it('enum|null + enum: (无 type) → 放行 (类型非 scalar 联合,不在扫描面)', () => {
    const sf = mk({
      '/apps/server/src/account/a.response.ts': `
        import { ApiProperty } from '@nestjs/swagger';
        enum Gender { MALE, FEMALE }
        class R {
          @ApiProperty({ enum: Gender, nullable: true })
          gender!: Gender | null;
        }`,
    });
    expect(scanSourceFiles(sf)).toHaveLength(0);
  });

  it('非 nullable string (无 |null) → 放行 (反射推得出标量)', () => {
    const sf = mk({
      '/apps/server/src/account/a.response.ts': `
        import { ApiProperty } from '@nestjs/swagger';
        class R { @ApiProperty({ example: 'x' }) phone!: string; }`,
    });
    expect(scanSourceFiles(sf)).toHaveLength(0);
  });

  it('scalar|null 但无 @ApiProperty 装饰器 → 放行 (不在 OpenAPI 契约面)', () => {
    const sf = mk({
      '/apps/server/src/account/a.response.ts': `
        class R { internal!: string | null; }`,
    });
    expect(scanSourceFiles(sf)).toHaveLength(0);
  });

  it('@ApiPropertyOptional 同样要求显式 type', () => {
    const sf = mk({
      '/apps/server/src/account/a.response.ts': `
        import { ApiPropertyOptional } from '@nestjs/swagger';
        class R { @ApiPropertyOptional({ nullable: true }) bio!: string | null; }`,
    });
    expect(fields(sf)).toEqual(['bio']);
  });

  it('@ApiProperty 无 config 对象 (裸调用) + scalar|null → 违规', () => {
    const sf = mk({
      '/apps/server/src/account/a.response.ts': `
        import { ApiProperty } from '@nestjs/swagger';
        class R { @ApiProperty() note!: string | null; }`,
    });
    expect(fields(sf)).toEqual(['note']);
  });

  it('多文件多违规 → 按 file/line 排序', () => {
    const sf = mk({
      '/apps/server/src/b/b.response.ts': `
        import { ApiProperty } from '@nestjs/swagger';
        class B { @ApiProperty({ nullable: true }) y!: string | null; }`,
      '/apps/server/src/a/a.response.ts': `
        import { ApiProperty } from '@nestjs/swagger';
        class A { @ApiProperty({ nullable: true }) x!: number | null; }`,
    });
    expect(fields(sf)).toEqual(['x', 'y']); // a.response.ts 在前
  });
});
