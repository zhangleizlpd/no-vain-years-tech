#!/bin/sh
# Container entrypoint: apply pending Prisma migrations, then start the server.
#
# `migrate deploy` is idempotent (already-applied migrations are skipped), so it
# is safe on every container start. Single-instance M1.1 deploy — no multi-writer
# migration race. DATABASE_URL is injected by docker-compose; the prisma CLI
# (a prod dependency) reads it via prisma.config.ts (datasource.url =
# process.env.DATABASE_URL), which also resolves schema + migrations paths.
set -e

node_modules/.bin/prisma migrate deploy

exec node dist/main.js
