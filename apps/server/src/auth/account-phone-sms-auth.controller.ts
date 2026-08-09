import { Body, Controller, Headers, HttpCode, Ip, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { normalizePhone } from '../account/account.rules';
import { assertValidSmsCode } from './sms-code.rules';
import { PhoneSmsAuthUseCase } from './phone-sms-auth.usecase';
import { PhoneSmsAuthRequest } from './phone-sms-auth.request';
import { PhoneSmsAuthResponse } from './phone-sms-auth.response';
import { ProblemDetailResponse } from '../security/problem-detail.response';

/**
 * POST /api/v1/accounts/phone-sms-auth
 *
 * US1 (ACTIVE) — phone + code → tokens.
 * US2 (auto-register) and US3 (anti-enumeration) plug into PhoneSmsAuthUseCase
 * in Phase 4/5; response shape is identical for byte-level anti-enumeration.
 *
 * accountId serialized as string (JSON-safe vs BigInt; matches FR-S09 + JWT sub claim).
 */
@ApiTags('accounts')
@Controller('v1/accounts')
export class AccountPhoneSmsAuthController {
  constructor(private readonly useCase: PhoneSmsAuthUseCase) {}

  @Post('phone-sms-auth')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Authenticate via phone + SMS code',
    description:
      'Verifies SMS code; auto-registers unregistered phones (US2); returns identical shape across all paths for byte-level anti-enumeration (US3).',
  })
  @ApiResponse({
    status: 200,
    description: 'Auth success — tokens issued',
    type: PhoneSmsAuthResponse,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failure (invalid phone format / code format)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Anti-enumeration auth failure (wrong code / expired / etc.)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 403,
    description: 'Account in 30-day freeze period (FR-S11; FROZEN disclosure)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Auth attempts locked (FR-S07 #4; 5 failures → 30-min lock)',
    type: ProblemDetailResponse,
  })
  async auth(
    @Body() body: PhoneSmsAuthRequest,
    @Ip() clientIp: string,
    @Headers('x-device-id') deviceId?: string,
    @Headers('x-device-name') deviceName?: string,
    @Headers('x-device-type') deviceType?: string,
  ): Promise<PhoneSmsAuthResponse> {
    const phone = normalizePhone(body.phone);
    assertValidSmsCode(body.code);
    const result = await this.useCase.execute(phone, body.code, {
      deviceId,
      deviceName,
      deviceType,
      clientIp,
    });
    return {
      accountId: result.accountId.toString(),
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    };
  }
}
