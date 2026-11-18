# syntax=docker/dockerfile:1
# Task Lite: one container, one process, one port (BUILD_SPEC §2).
# Build from the repository root:  docker build -f docker/Dockerfile .

ARG NODE_IMAGE=node:22-bookworm-slim

# ---- build: install the workspace, build shared, server and web ----
FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN npm install --global --no-fund --no-audit pnpm@9.15.0
WORKDIR /src

# Manifests first, so the dependency layer is cached until they change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store

COPY shared/ shared/
COPY server/ server/
COPY web/ web/
# The Help articles and the Workflow notes starter, bundled into the web build
# (BUILD_SPEC §5.17, §5.18).
COPY docs/help/ docs/help/
COPY docs/templates/WORKFLOW-starter.md docs/templates/WORKFLOW-starter.md
RUN pnpm -r build

# A self-contained server with production dependencies only.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @tasklite/server deploy --prod --store-dir /pnpm/store /out/server

# ---- runtime ----
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    TASKLITE_PORT=7420

RUN groupadd --system --gid 10001 tasklite \
 && useradd --system --uid 10001 --gid tasklite --home-dir /app --no-create-home \
      --shell /usr/sbin/nologin tasklite \
 && mkdir -p /data \
 && chown tasklite:tasklite /data

WORKDIR /app
COPY --from=build --chown=root:root /out/server /app/server
COPY --from=build --chown=root:root /src/web/dist /app/web/dist
# The sample seed's data (BUILD_SPEC §8), read by TASKLITE_SEED=sample and
# `tasklite seed sample`. The loader finds it at /app/design.
COPY --chown=root:root design/sample-data.json /app/design/sample-data.json
# The agent files (BUILD_SPEC §5.17): loaded into the bundled layer at startup
# from /app/skills/<name>/SKILL.md and /app/docs/templates/AGENTS-tasklite.md.
COPY --chown=root:root skills/ /app/skills/
COPY --chown=root:root docs/templates/AGENTS-tasklite.md /app/docs/templates/AGENTS-tasklite.md

# `tasklite owner-key | agent-token | seed sample` (BUILD_SPEC §3, MCP_SPEC §11).
RUN printf '#!/bin/sh\nexec node /app/server/dist/cli/index.js "$@"\n' > /usr/local/bin/tasklite \
 && chmod 755 /usr/local/bin/tasklite

USER tasklite
# A new named volume copies this directory, so /data starts owned by tasklite.
VOLUME ["/data"]
EXPOSE 7420

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.TASKLITE_PORT||7420)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["node", "server/dist/index.js"]
