# uWebSockets.js Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Substituir Fastify por uWebSockets.js em `api/src/server.ts` para reduzir overhead de HTTP processing e melhorar o p99 de latência.

**Architecture:** O servidor HTTP passa a ser implementado em C++ (uWebSockets.js) em vez de JavaScript (Fastify). Toda a lógica de negócio (FAISS, `toVector`, tipos) permanece intacta. Apenas `package.json` e `server.ts` mudam.

**Tech Stack:** Node.js 22, uWebSockets.js v20.51.0, TypeScript (`--experimental-strip-types`), faiss-node, pnpm (dev) / npm (Docker)

---

## Arquivos afetados

| Arquivo | Ação |
|---|---|
| `api/package.json` | Remover `fastify`, adicionar `uWebSockets.js` |
| `api/src/server.ts` | Reescrever inteiro com uWebSockets.js |

Nenhum outro arquivo é tocado.

---

### Task 1: Atualizar dependências

**Files:**
- Modify: `api/package.json`

- [ ] **Step 1: Verificar a versão mais recente do uWebSockets.js**

```bash
curl -s https://api.github.com/repos/uNetworking/uWebSockets.js/releases/latest | grep '"tag_name"'
```

Anote a tag retornada (ex: `v20.51.0`). Use ela no próximo passo.

- [ ] **Step 2: Atualizar package.json**

Substituir o conteúdo de `api/package.json` por:

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
    "uWebSockets.js": "github:uNetworking/uWebSockets.js#v20.51.0"
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

> Substitua `v20.51.0` pela tag obtida no Step 1 se for diferente.

- [ ] **Step 3: Instalar dependências**

```bash
cd api && pnpm install
```

Esperado: `node_modules/uWebSockets.js/` criado com binários pré-compilados para a plataforma atual.

- [ ] **Step 4: Confirmar que o binário foi instalado**

```bash
ls api/node_modules/uWebSockets.js/uws_*.node 2>/dev/null | head -3
```

Esperado: ao menos um arquivo `.node` listado (ex: `uws_darwin_arm64_131.node`).

- [ ] **Step 5: Commit**

```bash
cd api && git add package.json pnpm-lock.yaml && git commit -m "deps: troca fastify por uWebSockets.js"
```

---

### Task 2: Reescrever server.ts com uWebSockets.js

**Files:**
- Modify: `api/src/server.ts`

- [ ] **Step 1: Substituir o conteúdo completo de `api/src/server.ts`**

```typescript
import { resolve } from 'node:path'
import { App } from 'uWebSockets.js'
import { FaissService } from './faiss.ts'
import { toVector } from './normalize.ts'
import type { FraudRequest, NormalizationConfig } from './types.ts'

const DATA_DIR = process.env['DATA_DIR'] ?? '/data'

const norm: NormalizationConfig = {
  max_amount: 10000,
  max_installments: 12,
  amount_vs_avg_ratio: 10,
  max_minutes: 1440,
  max_km: 1000,
  max_tx_count_24h: 20,
  max_merchant_avg_amount: 10000,
}

const mccRisk: Map<string, number> = new Map([
  ['5411', 0.15],
  ['5812', 0.30],
  ['5912', 0.20],
  ['5944', 0.45],
  ['7801', 0.80],
  ['7802', 0.75],
  ['7995', 0.85],
  ['4511', 0.35],
  ['5311', 0.25],
  ['5999', 0.50],
])

const faiss = new FaissService(
  resolve(DATA_DIR, 'txns.index'),
  resolve(DATA_DIR, 'txns.labels'),
)

const app = App()

app.get('/ready', (res) => {
  faiss.search(new Array(14).fill(0))
  res.cork(() => {
    res.writeStatus('200 OK')
    res.end('ok')
  })
})

app.post('/fraud-score', (res) => {
  let aborted = false
  res.onAborted(() => { aborted = true })

  const chunks: Buffer[] = []

  res.onData((chunk, isLast) => {
    chunks.push(Buffer.from(chunk))
    if (!isLast) return

    if (aborted) return

    let body: FraudRequest
    try {
      body = JSON.parse(Buffer.concat(chunks).toString()) as FraudRequest
    } catch {
      res.cork(() => {
        res.writeStatus('400 Bad Request')
        res.end()
      })
      return
    }

    try {
      const vector = toVector(body, mccRisk, norm)
      const fraudCount = faiss.search(vector)
      const fraud_score = fraudCount / 5
      const response = JSON.stringify({ approved: fraud_score < 0.6, fraud_score })
      res.cork(() => {
        res.writeStatus('200 OK')
        res.writeHeader('Content-Type', 'application/json')
        res.end(response)
      })
    } catch {
      res.cork(() => {
        res.writeStatus('500 Internal Server Error')
        res.end()
      })
    }
  })
})

app.any('/*', (res) => {
  res.cork(() => {
    res.writeStatus('404 Not Found')
    res.end()
  })
})

app.listen(3000, (token) => {
  if (!token) throw new Error('Failed to listen on port 3000')
})
```

- [ ] **Step 2: Checar tipos**

```bash
cd api && pnpm typecheck
```

Esperado: sem erros. Se `uWebSockets.js` reclamar de tipos ausentes, adicione `// @ts-ignore` acima do import apenas como último recurso — mas o pacote já distribui tipos próprios, então não deve ser necessário.

- [ ] **Step 3: Commit**

```bash
git add api/src/server.ts && git commit -m "perf: substitui Fastify por uWebSockets.js no servidor HTTP"
```

---

### Task 3: Validar localmente com smoke test

**Files:** nenhum arquivo modificado — apenas validação

- [ ] **Step 1: Subir o servidor localmente em background**

```bash
cd api && DATA_DIR=$(pwd)/../data node --experimental-strip-types src/server.ts &
SERVER_PID=$!
sleep 1
```

> Se `/data` não existir localmente, o FAISS vai falhar ao carregar. Nesse caso, testar via Docker (Task 4).

- [ ] **Step 2: Testar GET /ready**

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ready
```

Esperado: `200`

- [ ] **Step 3: Testar POST /fraud-score**

```bash
curl -s -X POST http://localhost:3000/fraud-score \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "txn-smoke",
    "transaction": { "amount": 100.00, "installments": 1, "requested_at": "2024-01-15T10:00:00Z" },
    "customer": { "avg_amount": 100.00, "tx_count_24h": 2, "known_merchants": ["m1"] },
    "merchant": { "id": "m1", "mcc": "5411", "avg_amount": 100.00 },
    "terminal": { "is_online": true, "card_present": true, "km_from_home": 1.0 },
    "last_transaction": null
  }'
```

Esperado: JSON com `"approved"` booleano e `"fraud_score"` numérico entre 0 e 1.

- [ ] **Step 4: Encerrar servidor local**

```bash
kill $SERVER_PID 2>/dev/null || true
```

---

### Task 4: Build da imagem Docker e teste completo k6

**Files:**
- Modify temporariamente: `docker-compose.yml` (trocar `image:` por build local para teste)

- [ ] **Step 1: Build da imagem Docker com tag local**

```bash
cd /Users/isaque/projects/rinha-de-backend-2026
docker build -f api/Dockerfile -t rinha-local .
```

Esperado: build bem-sucedido, sem erros de compilação de binário nativo.

- [ ] **Step 2: Atualizar docker-compose.yml para usar imagem local**

Substituir as duas ocorrências de `image: ghcr.io/isaquetdiniz/rinha-de-backend-2026:a85d8b4` por `image: rinha-local` em `docker-compose.yml` (tanto em `api1` quanto em `api2`).

- [ ] **Step 3: Reiniciar o stack**

```bash
docker compose down && docker compose up -d
```

Aguardar ~5 segundos para o FAISS carregar o índice.

- [ ] **Step 3: Verificar /ready via nginx**

```bash
sleep 5 && curl -s -o /dev/null -w "%{http_code}" http://localhost:9999/ready
```

Esperado: `200`

- [ ] **Step 4: Rodar smoke test k6**

```bash
k6 run k6-test/smoke.js
```

Esperado: todos os checks passando (`checks: 100.00%`, `http_req_failed: 0.00%`).

- [ ] **Step 5: Rodar teste completo de avaliação**

```bash
k6 run k6-test/test.js
```

Aguardar ~2 minutos. O resultado é salvo em `test/results.json`.

- [ ] **Step 6: Comparar scores**

```bash
cat test/results.json | python3 -c "
import json, sys
r = json.load(sys.stdin)
print(f\"p99:          {r['p99']}\")
print(f\"p99_score:    {r['scoring']['p99_score']['value']}\")
print(f\"det_score:    {r['scoring']['detection_score']['value']}\")
print(f\"final_score:  {r['scoring']['final_score']}\")
"
```

Esperado: `p99` significativamente menor que 222ms e `final_score` maior que 1002.43 (baseline anterior).

- [ ] **Step 7: Commit do resultado**

```bash
git add test/results.json && git commit -m "perf: resultado k6 com uWebSockets.js"
```
