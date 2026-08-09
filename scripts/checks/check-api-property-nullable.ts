#!/usr/bin/env node
/**
 * check-api-property-nullable.ts — ts-morph AST 探针: nullable 标量 DTO 字段的
 * `@ApiProperty` 必须显式写 `type:`，否则 orval 误生成 `{ [k]: unknown } | null`。
 *
 * 坑 (per memory reference_nullable_apiproperty_needs_type_string_else_orval_objectmap):
 *   字段类型为 `string | null` (或 `number | null` / `boolean | null`) 的 `@ApiProperty`,
 *   若漏写 `type: 'string'`，`@nestjs/swagger` 反射对 `T | null` 联合推不出标量 →
 *   openapi.json 该 schema 退化为无 type → orval 生成 `{ [k]: unknown } | null`。
 *   漏写到 mobile 消费才暴露 (跑通 server 单测都过)。踩过 012 / 023 / 024 / 025。
 *
 * 规则:
 *   属性 TS 类型 = `<scalar> | null` 联合 (scalar ∈ string / number / boolean) +
 *   装饰器 `@ApiProperty` 或 `@ApiPropertyOptional` + 装饰器对象字面量**缺** `type:`
 *   且**缺** `enum:` → violation。
 *
 *   enum 字段 (类型 `Gender | null`，带 `enum: Gender`) 天然不在扫描面 —— 其类型不是
 *   scalar keyword 联合，故不误报 (enum 自带类型信息，反射推得出)。
 *
 * 设计同 check-server-moat: 始终全量扫描 (契约是 holistic invariant), lefthook 的 glob
 * 只决定**是否**跑、不决定**扫什么**。语法级遍历 (不做类型解析) → 快，不依赖
 * `prisma generate` / openapi 导出是否跑过 (卡在 DTO 源码层，早于生成产物)。
 *
 * Usage: pnpm tsx scripts/checks/check-api-property-nullable.ts
 * Exit:  0 全过 / 1 ≥1 违规
 *
 * Deps (@nvy/checks): ts-morph; run via root tsx。
 */
import { existsSync } from 'node:fs';
import { Node, Project, type ClassDeclaration, type SourceFile } from 'ts-morph';

const SERVER_ROOT = 'apps/server';
const SRC_GLOBS = [
  `${SERVER_ROOT}/src/**/*.ts`,
  `!${SERVER_ROOT}/src/**/*.spec.ts`,
  `!${SERVER_ROOT}/src/**/*.test.ts`,
  `!${SERVER_ROOT}/src/**/*.it.spec.ts`,
  `!${SERVER_ROOT}/src/generated/**`,
  `!${SERVER_ROOT}/src/__smoke__/**`,
];

/** 触发检查的 swagger 装饰器名 (两者对 `T | null` 联合都需显式 type)。 */
const API_PROPERTY_DECORATORS = new Set(['ApiProperty', 'ApiPropertyOptional']);

/** orval 能推出的标量 keyword (这些 `| null` 联合漏 type 才会退化)。 */
const SCALAR_KEYWORDS = new Set(['string', 'number', 'boolean']);

interface Violation {
  file: string;
  line: number;
  field: string;
  scalar: string;
  message: string;
}

/**
 * 属性类型节点是否为 `<scalar> | null` 联合;是则返回标量名 (string / number / boolean),
 * 否则 null。`Gender | null` 等非 scalar 联合返回 null (不在扫描面)。
 */
function scalarNullUnion(typeNode: Node | undefined): string | null {
  if (!typeNode || !Node.isUnionTypeNode(typeNode)) return null;
  const memberTexts = typeNode.getTypeNodes().map((n) => n.getText().trim());
  if (!memberTexts.includes('null')) return null;
  return memberTexts.find((t) => SCALAR_KEYWORDS.has(t)) ?? null;
}

/** 扫一个 class 的属性，收集缺 type/enum 的 nullable-scalar @ApiProperty。 */
function scanClass(cls: ClassDeclaration, filePath: string, violations: Violation[]): void {
  for (const prop of cls.getProperties()) {
    const scalar = scalarNullUnion(prop.getTypeNode());
    if (!scalar) continue; // 非 scalar|null 联合，反射推得出，跳过

    const deco = prop.getDecorators().find((d) => API_PROPERTY_DECORATORS.has(d.getName()));
    if (!deco) continue; // 无 @ApiProperty(Optional)，不在 OpenAPI 契约面

    const arg = deco.getArguments()[0];
    const hasConfig = arg && Node.isObjectLiteralExpression(arg);
    const hasType = hasConfig ? arg.getProperty('type') !== undefined : false;
    const hasEnum = hasConfig ? arg.getProperty('enum') !== undefined : false;
    if (hasType || hasEnum) continue; // 已显式 type 或 enum → 合法

    violations.push({
      file: filePath,
      line: prop.getNameNode().getStartLineNumber(),
      field: prop.getName(),
      scalar,
      message: `'${prop.getName()}: ${scalar} | null' 的 @${deco.getName()} 缺 type: '${scalar}' — @nestjs/swagger 对联合推不出标量，orval 会生成 { [k]: unknown } | null。补 \`type: '${scalar}'\``,
    });
  }
}

/**
 * 纯扫描核心 (语法级遍历 SourceFile[])。与 FS / glob 解耦 → 单测可喂 in-memory
 * ts-morph fixture (见 check-api-property-nullable.spec.ts)。
 */
export function scanSourceFiles(sourceFiles: SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const sf of sourceFiles) {
    for (const cls of sf.getClasses()) scanClass(cls, sf.getFilePath(), violations);
  }
  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** FS-driven 全量扫描 (CLI 入口): 从 glob 装载。 */
export function scanApiPropertyNullable(opts?: { srcGlobs?: string[] }): Violation[] {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: false },
  });
  project.addSourceFilesAtPaths(opts?.srcGlobs ?? SRC_GLOBS);
  return scanSourceFiles(project.getSourceFiles());
}

// ── CLI ────────────────────────────────────────────────────────────────────
function main(): void {
  if (!existsSync(`${SERVER_ROOT}/src`)) {
    console.log('[check-api-property-nullable] no apps/server/src (skip)');
    process.exit(0);
  }
  const violations = scanApiPropertyNullable();
  if (violations.length === 0) {
    console.log('[check-api-property-nullable] ✓ 0 违规 (nullable 标量 @ApiProperty 均显式 type)');
    process.exit(0);
  }
  console.error('❌ check-api-property-nullable: nullable 标量 @ApiProperty 漏 type (orval 退化)');
  for (const v of violations) {
    const rel = v.file.replace(`${process.cwd()}/`, '');
    console.error(`   - ${rel}:${v.line} [${v.field}] ${v.message}`);
  }
  console.error(`\n[check-api-property-nullable] ${violations.length} violation(s)`);
  process.exit(1);
}

// tsx 直跑时执行 CLI; 被 import (测试) 时不跑。
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
