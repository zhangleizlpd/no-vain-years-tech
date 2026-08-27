# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:22-alpine
ARG PNPM_VERSION=10.33.2

# ---------- Stage 1: builder ----------
# Full monorepo install + swc build + Prisma generate + pnpm deploy.
# Native bcrypt binding compiled here against node:22-alpine ABI; reused by runner.
FROM ${NODE_IMAGE} AS builder

RUN apk add --no-cache python3 make g++ libc6-compat

ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /workspace

# Workspace manifests first (better layer cache)
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json nx.json tsconfig.base.json tsconfig.json ./
COPY apps/server/package.json ./apps/server/
COPY packages/api-client/package.json ./packages/api-client/

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# Source after deps for caching
COPY apps/server ./apps/server
COPY packages ./packages
COPY eslint.config.mjs ./

# Prisma 7 driver-adapter mode: TS client generated, no query engine binary at runtime
RUN pnpm -C apps/server exec prisma generate

# Compile TS → JS via @nx/js:swc (output to apps/server/dist/)
RUN pnpm nx run server:build --skip-nx-cache

# pnpm deploy: produce portable prod folder at /deploy.
# Runs in workspace context so it honors root pnpm.onlyBuiltDependencies allowlist
# (bcrypt/prisma/@prisma/engines build scripts run). --legacy because
# inject-workspace-packages is not enabled (default false in pnpm 10).
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter=server --prod --legacy deploy /deploy

# ---------- Stage 2: runner ----------
FROM ${NODE_IMAGE} AS runner

ENV NODE_ENV=production
ENV PORT=3000

WORKDIR /app

# Patch OS packages to the latest Alpine patch level so Trivy-flagged,
# already-fixed base-image CVEs don't ship in the runtime image (e.g.
# CVE-2026-45447 HIGH — OpenSSL PKCS7_verify use-after-free, fixed in
# libssl3/libcrypto3 3.5.7-r0). Stays within the pinned node:22-alpine minor.
#
# 🚨 这一行**只有在 `runner` stage 不吃构建缓存时才成立**。指令字符串恒定 ⇒ 一旦上游
# 有 `cache-from`，BuildKit 每次都判 `CACHED` 而**不执行**它，镜像的补丁水平就被冻在
# 该层第一次构建那天 —— 措施还写在这里，但已经不生效了，且**不会报错**。
# 2026-08-27 实证：CVE-2026-14456 在 main 连红两轮，构建日志 `#25 … CACHED`，镜像里是
# `3.5.7-r0`（base 出厂 3.5.6-r0、当时最新 3.5.8-r0）—— 那个中间版本号就是冻结日期的指纹。
# ⇒ 保障在 `.github/workflows/ci.yml` 的 `no-cache-filters: runner`。**动这一行前先看那里**；
#   把 runner 放回缓存 = 把这条 CVE 防线悄悄关掉。
RUN apk upgrade --no-cache

# Strip global npm shipped with node:22-alpine — we use pnpm exclusively at
# build time and run plain `node main.js` at runtime, so npm is unused. Its
# bundled transitive deps (picomatch etc.) drag in HIGH/CRITICAL CVEs that
# Trivy flags (real, not false positives — e.g. CVE-2026-33671).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Deployed prod folder (package.json + node_modules with native bindings pre-built).
COPY --from=builder --chown=node:node /deploy /app

# dist/ and src/generated/prisma are gitignored so pnpm deploy skipped them —
# copy explicitly. dist/ already contains generated/prisma compiled JS.
COPY --from=builder --chown=node:node /workspace/apps/server/dist /app/dist

# Prisma schema + migrations for `prisma migrate deploy` at container start.
# Copied explicitly because pnpm deploy may skip them (same gitignore reason as
# dist/ above); migrate deploy needs schema + migrations/ + DATABASE_URL only.
COPY --from=builder --chown=node:node /workspace/apps/server/prisma /app/prisma
# prisma.config.ts supplies migrate's datasource url (process.env.DATABASE_URL)
# + schema/migrations paths; it imports dotenv (also a prod dep) at load.
COPY --from=builder --chown=node:node /workspace/apps/server/prisma.config.ts /app/prisma.config.ts

# Entrypoint: idempotent `prisma migrate deploy`, then exec the server.
COPY --chown=node:node apps/server/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

USER node

EXPOSE 3000

# Liveness probe — `/healthz/live` only asserts the Node process is alive
# (no Prisma/Redis check, per gap-audit A1). Lets docker/k8s restart a wedged
# container even when its dependency layer is intermittently down. Readiness
# (`/healthz/ready`) is exercised by orchestrator probes, not this HEALTHCHECK.
# Use 127.0.0.1 (not localhost): alpine /etc/hosts maps localhost to ::1 first,
# but the app binds IPv4 only -> wget localhost is refused, flapping unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --quiet --spider --tries=1 http://127.0.0.1:3000/healthz/live || exit 1

# Entrypoint runs `prisma migrate deploy` then `exec node dist/main.js`.
# `docker run --init` recommended for proper PID 1 signal handling.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
