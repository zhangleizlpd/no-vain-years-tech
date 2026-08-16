import { ApiProperty } from '@nestjs/swagger';

/** POST `/v1/research/reports` 响应（201）。 */
export class ResearchIngestResponse {
  @ApiProperty({
    description: '归档标识，可据此反查这份研报的元数据行',
    example: '42',
  })
  reportId!: string;

  @ApiProperty({
    description: '归一后的标的（`market:code`）',
    example: 'hk:01698',
  })
  symbol!: string;

  @ApiProperty({
    description:
      '归档对象位置。由内容指纹导出，与投递方无关 —— 同一份文件被多个投递方投递时复用同一个位置',
    example: 'research/<sha256>/report.pdf',
  })
  objectKey!: string;

  @ApiProperty({
    description: 'true = 这份之前已归档过，本次未新增任何对象或记录（重复投递是安全的）',
    example: false,
  })
  deduplicated!: boolean;

  @ApiProperty({
    description:
      '**落库**的标题（不是把请求参数原样回吐）。投递方声明的元数据没有任何一层会校验，回显落库值是他唯一的自查手段',
    example: '某公司深度研报',
  })
  title!: string;

  @ApiProperty({
    description: '**落库**的研报日期，`YYYY-MM-DD`（与请求参数同形，不出 ISO datetime）',
    example: '2026-08-01',
  })
  reportDate!: string;

  @ApiProperty({
    description:
      '你在（该投递方, 该标的）这条版本线上的第几次投递，从 1 起。**版本号最大的那份就是最新的**，而你刚投的这份就是最大的那份',
    example: 1,
  })
  version!: number;

  // 🚨 `type: 'string'` 不能省：`@nestjs/swagger` 对 `string | null` 联合反射推不出标量 ⇒
  // openapi.json 里该 schema 退化为无 type ⇒ orval 生成 objectmap 而不是 `string | null`。
  // **typecheck 全绿、lint 全绿、CI 无一处会红**，只在 mobile 侧用到时才发现类型是错的
  // （仓内 012 / 023 / 024 / 025 已踩）。机器闸 = scripts/checks/check-api-property-nullable.ts。
  @ApiProperty({
    type: 'string',
    nullable: true,
    description:
      '该标的**现在**在行情目录里叫什么。查不到（研报常常先于标的入库）或查询本身失败 → null，两者不可区分且都不影响投递成功。' +
      '⚠️ 名称对上只证明「不是投成了另一家公司」，**不证明市场选对了** —— 两地上市的 A/H 在目录里同名',
    example: '天工国际',
  })
  instrumentName!: string | null;
}
