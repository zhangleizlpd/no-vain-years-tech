import { registerAs } from '@nestjs/config';
import { z } from 'zod';

/**
 * Auth secrets (per ADR-0023 HMAC-SHA256 SMS code + JWT HS256 access token).
 * Both secrets share lifecycle/rotation policy with .env.example warning.
 *
 * min(32) matches the documented prod requirement; dev/test placeholder strings
 * in .env.example are >= 32 bytes so smoke tests stay green.
 */
const AuthConfigSchema = z.object({
  jwtSecret: z.string().min(32, 'AUTH_JWT_SECRET must be ≥ 32 bytes'),
  smsCodeHmacSecret: z.string().min(32, 'SMS_CODE_HMAC_SECRET must be ≥ 32 bytes'),
});

export type AuthConfig = z.infer<typeof AuthConfigSchema>;

export const authConfig = registerAs(
  'auth',
  (): AuthConfig =>
    AuthConfigSchema.parse({
      jwtSecret: process.env.AUTH_JWT_SECRET,
      smsCodeHmacSecret: process.env.SMS_CODE_HMAC_SECRET,
    }),
);
