#!/usr/bin/env node
/**
 * One-shot CLI: boot the compiled AppModule (dist/), build OpenAPI 3.1 doc via
 * SwaggerModule.createDocument, write JSON snapshot to disk, exit. Consumed by
 * packages/api-client codegen as a connection-free OpenAPI source.
 *
 * Requires `pnpm nx run server:build` first (dump-openapi.mjs uses dist/).
 *
 * Run from `apps/server/`:
 *   pnpm api:dump                 # → apps/server/openapi.json
 *   pnpm api:dump custom/path.json
 *
 * Requires PG + Redis up (docker-compose.dev.yml) — Prisma onModuleInit connects.
 * For a connection-free dump in CI, swap AppModule for a slimmer ApiModule (TBD).
 */
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const distRoot = resolve(__dirname, '..', 'dist');

const { NestFactory } = require('@nestjs/core');
const { FastifyAdapter } = require('@nestjs/platform-fastify');
const { SwaggerModule } = require('@nestjs/swagger');
const { AppModule } = require(resolve(distRoot, 'app', 'app.module.js'));
const { buildOpenApiConfig } = require(resolve(distRoot, 'openapi.config.js'));

async function main() {
  const outPath = resolve(process.cwd(), process.argv[2] ?? 'openapi.json');
  const app = await NestFactory.create(AppModule, new FastifyAdapter(), {
    logger: false,
  });
  app.setGlobalPrefix('api');
  await app.init();
  const document = SwaggerModule.createDocument(app, buildOpenApiConfig());
  writeFileSync(outPath, JSON.stringify(document, null, 2) + '\n');
  await app.close();
  console.log(`✓ OpenAPI 3.1 snapshot written: ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
