# Remove Qdrant — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminar o diretório `qdrant/` completamente, consolidando tudo que ainda é necessário dentro de `api/` e atualizando Dockerfile e docker-compose.

**Architecture:** Os dados de runtime (`mcc_risk.json`, `normalization.json`) e o dataset (`references.json.gz`) migram para dentro de `api/`. O teste de `parse-refs` migra de `qdrant/scripts/` para `api/scripts/`. O código Qdrant (`build-index.ts`, `@qdrant/js-client-rest`) é deletado sem substituto.

**Tech Stack:** Node.js 22, TypeScript (strip-types), faiss-node, Fastify, pnpm, Docker

---

## Estrutura Final

```
rinha-de-backend-2026/
├── api/
│   ├── Dockerfile
│   ├── mcc_risk.json           ← era qdrant/mcc_risk.json
│   ├── normalization.json      ← era qdrant/normalization.json
│   ├── references.json.gz      ← era qdrant/references.json.gz
│   ├── package.json
│   ├── pnpm-lock.yaml
│   ├── tsconfig.json
│   ├── scripts/
│   │   ├── build-faiss-index.ts
│   │   ├── parse-refs.ts
│   │   └── parse-refs.test.ts  ← migrado de qdrant/scripts/
│   └── src/
│       ├── faiss.ts
│       ├── normalize.ts
│       ├── normalize.test.ts
│       ├── server.ts
│       └── types.ts
├── nginx/
│   └── nginx.conf
├── docker-compose.yml
├── info.json
└── LICENSE
```

---

## Task 1: Mover arquivos para api/ com git mv

**Files:**
- Modify: estrutura de diretórios via `git mv`

- [ ] **Step 1: Mover os arquivos de dados para api/**

```bash
git mv qdrant/mcc_risk.json api/mcc_risk.json
git mv qdrant/normalization.json api/normalization.json
git mv qdrant/references.json.gz api/references.json.gz
```

- [ ] **Step 2: Mover o teste de parse-refs para api/scripts/**

```bash
git mv qdrant/scripts/parse-refs.test.ts api/scripts/parse-refs.test.ts
```

- [ ] **Step 3: Confirmar que nenhum arquivo necessário ficou para trás**

```bash
find qdrant -not -path '*/node_modules*' | sort
```

Expected: apenas arquivos que serão deletados na próxima task:
```
qdrant/.dockerignore
qdrant/Dockerfile
qdrant/scripts/.gitignore
qdrant/scripts/build-index.ts
qdrant/scripts/package.json
qdrant/scripts/parse-refs.ts
qdrant/scripts/pnpm-lock.yaml
qdrant/scripts/tsconfig.json
qdrant/scripts/types.ts
```

---

## Task 2: Deletar tudo que restou em qdrant/

**Files:**
- Delete: todos os arquivos Qdrant-específicos

- [ ] **Step 1: Remover via git rm**

```bash
git rm qdrant/.dockerignore
git rm qdrant/Dockerfile
git rm "qdrant/scripts/.gitignore"
git rm qdrant/scripts/build-index.ts
git rm qdrant/scripts/package.json
git rm qdrant/scripts/parse-refs.ts
git rm qdrant/scripts/pnpm-lock.yaml
git rm qdrant/scripts/tsconfig.json
git rm qdrant/scripts/types.ts
```

- [ ] **Step 2: Verificar que qdrant/ não existe mais no git**

```bash
git status --short | grep qdrant
```

Expected: todas as linhas com `D` (deleted) ou `R` (renamed) — zero `?` ou `M`

---

## Task 3: Atualizar Dockerfile

**Files:**
- Modify: `api/Dockerfile`

O Dockerfile atual copia `qdrant/references.json.gz` do contexto root. Como o contexto continua sendo `.` (root), precisamos ajustar o COPY para o novo caminho `api/references.json.gz`.

- [ ] **Step 1: Reescrever o Dockerfile**

```dockerfile
# Stage 1: Build Faiss index
FROM node:22-bookworm-slim AS builder
WORKDIR /build
COPY api/package.json ./
RUN npm install
COPY api/scripts/ ./scripts/
COPY api/references.json.gz ./references.json.gz
RUN node --experimental-strip-types scripts/build-faiss-index.ts

# Stage 2: Runtime
FROM node:22-bookworm-slim
WORKDIR /app
COPY api/package.json ./
RUN npm install --omit=dev
COPY api/src/ ./src/
COPY --from=builder /data/txns.index /data/txns.index
COPY --from=builder /data/txns.labels /data/txns.labels
EXPOSE 3000
CMD ["node", "--experimental-strip-types", "src/server.ts"]
```

---

## Task 4: Atualizar docker-compose.yml

**Files:**
- Modify: `docker-compose.yml`

Os volumes de `api1` e `api2` montam `./qdrant/mcc_risk.json` e `./qdrant/normalization.json`. Precisam apontar para `./api/mcc_risk.json` e `./api/normalization.json`.

- [ ] **Step 1: Atualizar os volume mounts**

```yaml
services:
  nginx:
    image: nginx:alpine
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
    ports:
      - "9999:9999"
    depends_on:
      - api1
      - api2
    networks:
      - backend
    deploy:
      resources:
        limits:
          cpus: "0.1"
          memory: "30MB"

  api1:
    build:
      context: .
      dockerfile: api/Dockerfile
    environment:
      DATA_DIR: /data
    volumes:
      - ./api/mcc_risk.json:/data/mcc_risk.json:ro
      - ./api/normalization.json:/data/normalization.json:ro
    networks:
      - backend
    deploy:
      resources:
        limits:
          cpus: "0.45"
          memory: "160MB"

  api2:
    build:
      context: .
      dockerfile: api/Dockerfile
    environment:
      DATA_DIR: /data
    volumes:
      - ./api/mcc_risk.json:/data/mcc_risk.json:ro
      - ./api/normalization.json:/data/normalization.json:ro
    networks:
      - backend
    deploy:
      resources:
        limits:
          cpus: "0.45"
          memory: "160MB"

networks:
  backend:
    driver: bridge
```

---

## Task 5: Atualizar package.json — test script

**Files:**
- Modify: `api/package.json`

- [ ] **Step 1: Incluir scripts/*.test.ts no comando de teste**

```json
{
  "name": "rinha-api",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "node --experimental-strip-types --test 'src/*.test.ts' 'scripts/*.test.ts'"
  },
  "dependencies": {
    "faiss-node": "^0.5.1",
    "fastify": "^5.0.0"
  },
  "pnpm": {
    "onlyBuiltDependencies": ["faiss-node"]
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/stream-chain": "^2.1.0",
    "@types/stream-json": "^1.7.7",
    "stream-chain": "^2.2.5",
    "stream-json": "^1.8.0",
    "typescript": "^5.5.0"
  }
}
```

---

## Task 6: Verificar e corrigir parse-refs.test.ts

**Files:**
- Modify: `api/scripts/parse-refs.test.ts` (se necessário)

O arquivo migrado de `qdrant/scripts/parse-refs.test.ts` importa `from './parse-refs.ts'`. A versão em `api/scripts/parse-refs.ts` inline a interface `ReferenceRecord` (sem `types.ts` separado). O teste não importa o tipo — só usa a função. Deve funcionar sem alterações, mas precisa verificar.

- [ ] **Step 1: Confirmar que o import usa extensão .ts**

Ler `api/scripts/parse-refs.test.ts` e verificar linha 5:
```ts
import { parseReferences } from './parse-refs.ts'
```
Se estiver sem `.ts`, corrigir para adicionar a extensão (Node.js strip-types exige).

---

## Task 7: Rodar testes e typecheck

**Files:**
- none (verificação)

- [ ] **Step 1: Instalar dependências**

```bash
cd /Users/isaque/projects/rinha-de-backend-2026/api && pnpm install
```

Expected: sem erros, `node_modules/` atualizado

- [ ] **Step 2: Typecheck**

```bash
pnpm typecheck
```

Expected: zero erros de TypeScript

- [ ] **Step 3: Rodar testes**

```bash
pnpm test
```

Expected: todos os 6 testes passando:
```
✔ transação legítima sem last_transaction
✔ transação fraudulenta sem last_transaction
✔ com last_transaction presente
✔ avg_amount zero → dim[2] = 1.0
✔ emite todos os registros na ordem correta
✔ preserva valores -1 nas dimensões 5 e 6
```

---

## Task 8: Commit

- [ ] **Step 1: Verificar git status final**

```bash
git status --short
```

Confirmar: nenhuma referência a `qdrant/` permanece

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "refactor: remove qdrant, consolidate files in api/"
```
