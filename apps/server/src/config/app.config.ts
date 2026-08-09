import { registerAs } from '@nestjs/config';
import { z } from 'zod';

/**
 * App-level runtime config (per A4 typed config gap, plan 05-22-mono-meta-backend-gap-audit.md).
 *
 * Boot-phase Zod parse → fail-fast on missing/invalid env *before* listen.
 * Business code MUST consume via `@Inject(appConfig.KEY) cfg: AppConfig`,
 * never via raw `configService.get('PORT')`.
 */
const AppConfigSchema = z.object({
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  port: z.coerce.number().int().positive().max(65535).default(3000),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  // `*` → permissive (dev only); comma-separated origins → strict allowlist.
  // parseOrigins helper resolves runtime semantics (see parse-origins.ts).
  corsAllowedOrigins: z.string().default('*'),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

export const appConfig = registerAs(
  'app',
  (): AppConfig =>
    AppConfigSchema.parse({
      nodeEnv: process.env.NODE_ENV,
      port: process.env.PORT,
      logLevel: process.env.LOG_LEVEL,
      corsAllowedOrigins: process.env.CORS_ALLOWED_ORIGINS,
    }),
);
