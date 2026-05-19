# Stage 1: Build addon C++ + índice IVF
FROM node:22-trixie-slim AS builder

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY api/package.json ./
RUN npm install

# Compila o addon C++
COPY api/knn-addon/ ./knn-addon/
WORKDIR /build/knn-addon
RUN npx node-gyp configure && npx node-gyp build

# Gera o índice IVF
WORKDIR /build
COPY api/scripts/ ./scripts/
COPY api/references.json.gz ./references.json.gz
RUN OUTPUT_DIR=/data KNN_NLIST=1024 KNN_ITERATIONS=20 \
    node --experimental-strip-types scripts/build-knn-index.ts

# Stage 2: Runtime
FROM node:22-trixie-slim

WORKDIR /app
COPY api/package.json ./
RUN npm install --omit=dev
COPY api/src/ ./src/
COPY api/knn-addon/index.js         ./knn-addon/index.js
COPY api/knn-addon/package.json     ./knn-addon/package.json
COPY --from=builder /build/knn-addon/build/Release/knn.node ./knn-addon/build/Release/knn.node
COPY --from=builder /data/knn.index /data/knn.index

CMD ["node", "--experimental-strip-types", "src/server.ts"]
