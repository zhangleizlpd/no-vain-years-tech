import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';

/**
 * GET /api/v1/auth/devices query (FR-S01)。
 *
 * 全局 ValidationPipe (transform:true) 把 query string 转 number;非 int / 负数 →
 * 400 FORM_VALIDATION (class-validator 失败统一映射, per main.ts exceptionFactory)。
 * 缺省 page=0 / size=10。size 上限 100 不在此校验 —— 超限**截断**(非拒绝),由
 * RefreshTokenService clamp 处理 (FR-S01「超限截断」)。
 */
export class DeviceListQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  page = 0;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  size = 10;
}
