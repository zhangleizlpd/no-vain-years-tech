import { registerAs } from '@nestjs/config';
import { z } from 'zod';

const RedisConfigSchema = z.object({
  url: z.string().url('REDIS_URL must be a valid URL'),
});

export type RedisConfig = z.infer<typeof RedisConfigSchema>;

export const redisConfig = registerAs(
  'redis',
  (): RedisConfig =>
    RedisConfigSchema.parse({
      url: process.env.REDIS_URL,
    }),
);
