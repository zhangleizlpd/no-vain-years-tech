import { registerAs } from '@nestjs/config';
import { z } from 'zod';

const DbConfigSchema = z.object({
  url: z.string().url('DATABASE_URL must be a valid URL'),
});

export type DbConfig = z.infer<typeof DbConfigSchema>;

export const dbConfig = registerAs(
  'db',
  (): DbConfig =>
    DbConfigSchema.parse({
      url: process.env.DATABASE_URL,
    }),
);
