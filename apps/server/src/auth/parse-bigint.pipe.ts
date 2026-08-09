import { Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import { FormValidationException } from '../security/form-validation.exception';

/**
 * 路径参数 bigint 解析 + 校验。行 PK (refresh_token.id 等) 是 BigInt,可能超
 * Number.MAX_SAFE_INTEGER,故不用 ParseIntPipe (number)。仅接受非负整数串 → BigInt;
 * 非法 → 400 FORM_VALIDATION (与 query / body 校验统一错误码契约, per ADR-0038)。
 */
@Injectable()
export class ParseBigIntPipe implements PipeTransform<string, bigint> {
  transform(value: string, metadata: ArgumentMetadata): bigint {
    if (typeof value === 'string' && /^\d+$/.test(value)) {
      return BigInt(value);
    }
    throw new FormValidationException([
      { field: metadata.data ?? 'param', messages: ['must be a non-negative integer'] },
    ]);
  }
}
