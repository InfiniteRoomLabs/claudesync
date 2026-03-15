# --------------------------------------------------------------------------
# ClaudeSync -- Multi-stage, multi-target Docker build
# Two targets: "mcp" (MCP server) and "cli" (CLI tool)
# Uses node:24-slim (glibc) because better-sqlite3 needs glibc.
#
# Build:
#   docker build --target mcp -t claudesync-mcp .
#   docker build --target cli -t claudesync .
# --------------------------------------------------------------------------

# ---- Stage 1: deps ----
FROM node:24-slim AS deps

RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY packages/core/package.json packages/core/package.json
COPY packages/mcp-server/package.json packages/mcp-server/package.json
COPY packages/cli/package.json packages/cli/package.json

RUN pnpm install --frozen-lockfile

# ---- Stage 2: builder ----
FROM deps AS builder

WORKDIR /app

COPY tsconfig.base.json ./
COPY packages/core/ packages/core/
COPY packages/mcp-server/ packages/mcp-server/
COPY packages/cli/ packages/cli/

RUN pnpm --filter @infinite-room-labs/claudesync-core build && \
    pnpm --filter @infinite-room-labs/claudesync-mcp-server build && \
    pnpm --filter @infinite-room-labs/claudesync-cli build

# Prune each target to production deps only
# --legacy required for pnpm v10+ with non-injected workspace deps
RUN pnpm --filter @infinite-room-labs/claudesync-mcp-server --prod deploy --legacy /app/pruned-mcp
RUN pnpm --filter @infinite-room-labs/claudesync-cli --prod deploy --legacy /app/pruned-cli

# ---- Target: mcp ----
FROM node:24-slim AS mcp

LABEL org.opencontainers.image.title="ClaudeSync MCP Server" \
      org.opencontainers.image.description="MCP server for programmatic access to claude.ai conversations" \
      org.opencontainers.image.source="https://github.com/InfiniteRoomLabs/claudesync" \
      org.opencontainers.image.vendor="Infinite Room Labs LLC" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app
COPY --from=builder --chown=node:node /app/pruned-mcp /app
USER node

ENTRYPOINT ["node", "dist/index.js"]

# ---- Target: cli ----
# Includes git for exportToGit(). Uses the built-in node user (UID 1000)
# which matches most host users -- files written to mounted volumes are
# owned by the host user without needing --user flags.
# WORKDIR is /data (the mount point) so relative paths resolve to the host CWD.
FROM node:24-slim AS cli

LABEL org.opencontainers.image.title="ClaudeSync CLI" \
      org.opencontainers.image.description="Export claude.ai conversations as git repositories" \
      org.opencontainers.image.source="https://github.com/InfiniteRoomLabs/claudesync" \
      org.opencontainers.image.vendor="Infinite Room Labs LLC" \
      org.opencontainers.image.licenses="MIT"

RUN apt-get update && \
    apt-get install -y --no-install-recommends git && \
    rm -rf /var/lib/apt/lists/* && \
    mkdir -p /data && chown node:node /data

COPY --from=builder --chown=node:node /app/pruned-cli /app
USER node
WORKDIR /data

ENTRYPOINT ["node", "/app/dist/index.js"]
