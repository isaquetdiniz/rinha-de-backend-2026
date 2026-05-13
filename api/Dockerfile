# Stage 1: Build Faiss index
FROM node:22-noble-slim AS builder
WORKDIR /build
RUN apt-get update && apt-get install -y git --no-install-recommends && rm -rf /var/lib/apt/lists/* \
    && git config --global url."https://".insteadOf ssh:// \
    && git config --global url."https://github.com/".insteadOf git@github.com:
COPY api/package.json ./
RUN npm install
COPY api/scripts/ ./scripts/
COPY api/references.json.gz ./references.json.gz
RUN node --experimental-strip-types scripts/build-faiss-index.ts

# Stage 2: Runtime
FROM node:22-noble-slim
WORKDIR /app
RUN apt-get update && apt-get install -y git --no-install-recommends && rm -rf /var/lib/apt/lists/* \
    && git config --global url."https://".insteadOf ssh:// \
    && git config --global url."https://github.com/".insteadOf git@github.com:
COPY api/package.json ./
RUN npm install --omit=dev
COPY api/src/ ./src/
COPY --from=builder /data/txns.index /data/txns.index
COPY --from=builder /data/txns.labels /data/txns.labels
EXPOSE 3000
CMD ["node", "--experimental-strip-types", "src/server.ts"]
