# ── Stage 1: constrói o índice HNSW ─────────────────────────────
FROM qdrant/qdrant:latest AS builder

USER root

RUN apt-get update && apt-get install -y curl && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    corepack enable && corepack prepare pnpm@latest --activate && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /scripts
COPY scripts/package.json scripts/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY scripts/ ./
COPY references.json.gz ./

RUN mkdir -p /qdrant/storage && \
    QDRANT__STORAGE__STORAGE_PATH=/qdrant/storage /qdrant/qdrant & \
    node --experimental-strip-types build-index.ts && \
    pkill -f qdrant && wait || true

# ── Stage 2: imagem de runtime ───────────────────────────────────
FROM qdrant/qdrant:latest
COPY --from=builder /qdrant/storage /qdrant/storage
