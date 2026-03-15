# --------------------------------------------------------------------------
# ClaudeSync MCP Server -- Multi-stage Docker build
# Only @claudesync/mcp-server is containerized. Uses node:24-slim (glibc)
# because better-sqlite3 is a native C++ addon that requires glibc.
# --------------------------------------------------------------------------

# ---- Stage 1: deps ----
# Install pnpm, copy manifests, install dependencies, build native modules
FROM node:24-slim AS deps

RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy workspace config and all package.json files first (layer caching)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY packages/core/package.json packages/core/package.json
COPY packages/mcp-server/package.json packages/mcp-server/package.json
COPY packages/cli/package.json packages/cli/package.json

RUN pnpm install --frozen-lockfile

# ---- Stage 2: builder ----
# Copy source code and compile TypeScript for core + mcp-server
FROM deps AS builder

WORKDIR /app

COPY tsconfig.base.json ./
COPY packages/core/ packages/core/
COPY packages/mcp-server/ packages/mcp-server/

RUN pnpm --filter @claudesync/core build && \
    pnpm --filter @claudesync/mcp-server build

# Prune to production dependencies only
RUN pnpm --filter @claudesync/mcp-server --prod deploy /app/pruned

# ---- Stage 3: runtime ----
# Slim production image -- no build tools, no source code
FROM node:24-slim AS runtime

LABEL org.opencontainers.image.title="ClaudeSync MCP Server" \
      org.opencontainers.image.description="MCP server for programmatic access to claude.ai conversations" \
      org.opencontainers.image.source="https://github.com/InfiniteRoomLabs/claudesync" \
      org.opencontainers.image.vendor="Infinite Room Labs LLC" \
      org.opencontainers.image.licenses="MIT"

RUN groupadd --gid 1001 claudesync && \
    useradd --uid 1001 --gid 1001 --shell /bin/false claudesync

WORKDIR /app

# Copy pruned production deployment from builder
COPY --from=builder --chown=1001:1001 /app/pruned /app

USER claudesync

ENTRYPOINT ["node", "dist/index.js"]
