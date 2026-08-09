---
paths:
  - '**/Dockerfile*'
  - '**/docker-compose*.yml'
  - '**/.dockerignore'
---

# Docker / Compose 纪律（path-triggered，触及 Dockerfile / compose / `.dockerignore` 自动加载）

## 单源真理

部署拓扑（SWAS 单实例 + 同机 PG/Redis docker compose + ACR 镜像 + A-Tight v2 继承）见 [ADR-0026](../../docs/adr/0026-backend-deployment-topology.md)；secrets 注入（`.env.production` volume mount）见 [ADR-0037](../../docs/adr/0037-security-credentials-governance.md)。活的真相在 `apps/server/Dockerfile` + `docker-compose.{dev,tight}.yml` 本身（含 inline rationale）。本 rule 仅 surface 改 Docker 产物时的硬 invariant，不重复部署决策 / 不镜像当前配置值。

## 硬性 invariant

### 1. Dockerfile

- **multi-stage**：builder 编译 + runner 运行；构建工具 / 编译中间产物不进 runtime 镜像
- base image **显式 pin**（`node:<major>-alpine` 走 `ARG`），**禁 `:latest`**
- **non-root** 运行（`USER node`）
- `CMD` / `ENTRYPOINT` 用 **exec 形式**（PID 1 正确收 SIGTERM；推荐 `docker run --init`）
- 显式 `EXPOSE` + `HEALTHCHECK`，探活打 `/healthz/live`（只断言进程存活，不掺 Prisma/Redis 检查，per gap-audit A1）
- 产线产物走 `pnpm --filter=server --prod --legacy deploy`（`--legacy` 因 `inject-workspace-packages` 默认关）；sub-package 必须显式声明所有 runtime dep（monorepo dev hoist 会掩盖缺失，prune/deploy 后才 fatal）
- runner stage **删 base image 自带 npm**（`rm -rf .../node_modules/npm .../bin/npm{,x}`）：pnpm-only，npm 的 transitive CVE 会被 Trivy 真实 flag（非误报）

### 2. docker-compose

- 必须 `name:` 字段（避免不同目录 / dev vs tight 的 compose project 撞名）
- image 版本显式 pin；app 镜像 tag 由 `.env.production` 的 `${MBW_VERSION}` 注入，不裸 `:latest`
- 每个服务必须 `healthcheck`（让 `depends_on: condition: service_healthy` 生效）
- named volume 加项目前缀
- 文件按角色拆：`docker-compose.dev.yml`（本机开发）/ `.tight.yml`（单节点生产）—— **禁单一 compose 混 dev/prod**

### 3. 安全

- secrets **不 bake 进镜像** —— 走 `.env.production` volume mount（per ADR-0037）
- CI 跑 Trivy fs scan + image scan（HIGH+ 阻塞合并，见 `.github/workflows/ci.yml`）；`ignore-unfixed` 不阻塞修不了的上游 vendor 漏洞
- `.dockerignore` 必须排除：构建产物（`node_modules` / `dist` / `.nx` / `.swc` / coverage）+ `.env*` secrets + `.git` + `docs` / `specs` / `.github` / `.claude` / `.specify`

## 反模式

- ❌ 单 stage Dockerfile（runtime 镜像臃肿 + 构建工具混入）
- ❌ root user / `:latest` tag / secrets bake 进镜像
- ❌ 服务缺 healthcheck（`depends_on` 失效）
- ❌ 单文件混 dev/prod
