# Design: Rinha de Backend 2026 — Fraud Detection

**Data:** 2026-05-11  
**Stack:** Node.js + TypeScript (Fastify) + Qdrant  
**Desafio:** API de detecção de fraude via KNN em 3M vetores dentro de 1 CPU e 350 MB RAM

---

## 1. Contexto e Objetivo

A Rinha de Backend 2026 exige uma API REST que classifica transações como fraude ou legítimas usando KNN (k=5) sobre um dataset de 3 milhões de vetores de 14 dimensões, com distância euclidiana.

Pontuação final = **score de latência** (p99) + **score de detecção** (precisão). A estratégia é maximizar latência (vale mais) sem comprometer o recall abaixo dos 15% de erro.

---

## 2. Arquitetura

```
porta 9999
┌─────────┐
│  nginx  │  0.1 CPU · 30 MB
└────┬────┘
     │ round-robin
┌────┴────────────────────┐
│  api1       api2        │  0.2 CPU · 60 MB cada
│  Fastify    Fastify     │  :3000
└────┬────────────────────┘
     │ gRPC
┌────▼────┐
│ Qdrant  │  0.5 CPU · 200 MB  :6334
└─────────┘
```

| Recurso | Alocação | Total |
|---------|----------|-------|
| CPU | 0.1 + 0.2 + 0.2 + 0.5 | **1.0** |
| RAM | 30 + 60 + 60 + 200 MB | **350 MB** |

### Serviços

- **nginx**: load balancer round-robin na porta 9999, keepalive habilitado
- **api1 / api2**: Fastify com Node.js 22 Alpine + TypeScript compilado; normalizam o payload e consultam o Qdrant via gRPC
- **qdrant**: banco vetorial com índice HNSW pré-construído na imagem Docker

---

## 3. Fluxo de um Request

```
1. POST /fraud-score → nginx → api (round-robin)
2. api parseia JSON
3. api normaliza 14 campos → Float32Array[14]
4. api envia vetor ao Qdrant via gRPC
5. Qdrant retorna 5 vizinhos mais próximos com label fraud/legit
6. api calcula fraud_score = fraudes / 5
7. api retorna { approved: fraud_score < 0.6, fraud_score }
```

---

## 4. Normalização (14 Dimensões)

Todos os valores são clamped em [0, 1], exceto dimensões 5 e 6 quando `last_transaction` é null (ficam -1).

| Dim | Campo | Fórmula |
|-----|-------|---------|
| 0 | transaction.amount | `clamp(amount / 10_000)` |
| 1 | transaction.installments | `clamp(installments / 12)` |
| 2 | amount vs avg | `avg_amount > 0 ? clamp((amount / avg_amount) / 10) : 1.0` |
| 3 | hora do dia | `hour(requested_at) / 23` |
| 4 | dia da semana | `dayOfWeek(requested_at) / 6` |
| 5 | minutos desde última tx | `clamp(minutes / 1440)` ou `-1` se null |
| 6 | km da última tx | `clamp(km_from_current / 1000)` ou `-1` se null |
| 7 | km de casa | `clamp(km_from_home / 1000)` |
| 8 | tx nas últimas 24h | `clamp(tx_count_24h / 20)` |
| 9 | terminal online | `1 \| 0` |
| 10 | cartão presente | `1 \| 0` |
| 11 | merchant desconhecido | `1 se não está em known_merchants, 0 caso contrário` |
| 12 | MCC risk | lookup em `mcc_risk.json`, default `0.5` |
| 13 | merchant avg amount | `clamp(merchant.avg_amount / 10_000)` |

Constantes de normalização (`normalization.json`):
- max_amount: 10.000
- max_installments: 12
- amount_vs_avg_ratio: 10
- max_minutes: 1.440
- max_km: 1.000
- max_tx_count_24h: 20
- max_merchant_avg_amount: 10.000

---

## 5. Configuração do Qdrant

### Coleção `txns`

```json
{
  "vectors": {
    "size": 14,
    "distance": "Euclid",
    "on_disk": true
  },
  "quantization_config": {
    "scalar": {
      "type": "int8",
      "quantile": 0.99,
      "always_ram": true
    }
  },
  "hnsw_config": {
    "m": 4,
    "ef_construct": 200,
    "on_disk": false
  }
}
```

### Uso de Memória do Qdrant

| Componente | Tamanho |
|------------|---------|
| Grafo HNSW (m=4, 3M vetores) | ~96 MB (RAM) |
| Vetores int8 quantizados | ~42 MB (RAM) |
| Vetores float32 originais | ~168 MB (disco) |
| Overhead Qdrant | ~20 MB (RAM) |
| **Total RAM** | **~158 MB** |

### Parâmetro `ef` na query

Valor padrão: 128. Pode ser reduzido para 64 ou 32 para menor latência com pequena perda de recall. Ajustável sem rebuildar o índice.

---

## 6. Estratégia de Pré-build do Índice

O health check da Rinha aguarda 60 segundos (20 × 3s). Construir o índice HNSW para 3M vetores em runtime leva ~3–5 minutos — inviável.

**Solução:** índice pré-construído durante o `docker build`.

### Dockerfile do Qdrant (multi-stage)

```
Stage 1 (builder):
  - Copia references.json.gz
  - Inicia Qdrant em background
  - Executa script Node.js: parseia JSON.gz, insere 3M vetores em batches, aguarda otimização do índice
  - Encerra Qdrant
  - Storage resultante: ~270 MB em disco

Stage 2 (runtime):
  - Imagem base qdrant/qdrant:v1.13
  - Copia storage do Stage 1
  - Startup em < 5 segundos
```

### Arquivos de referência fornecidos pela organização

Os arquivos abaixo são providos pelos organizadores da Rinha e devem estar presentes no repositório (ou baixados via script no build):

- `references.json.gz` — 3M vetores rotulados (fraud/legit)
- `mcc_risk.json` — risco por MCC
- `normalization.json` — constantes de normalização

Os valores de normalização são lidos de `normalization.json` no startup do script de build e da API, não hardcodados.

### Script de inserção

- Parse streaming de `references.json.gz` (evita alocar tudo em RAM)
- Batches de 2.000 vetores com `wait: false` (paraleliza inserção e indexação)
- Último batch com `wait: true`
- Força otimização final com `indexing_threshold: 0`
- Aguarda status `green` antes de encerrar

---

## 7. Estrutura do Repositório

```
rinha-de-backend-2026/
├── api/
│   ├── src/
│   │   ├── server.ts       # Fastify, rotas /ready e /fraud-score
│   │   ├── normalize.ts    # toVector(payload, mccRisk) → Float32Array[14]
│   │   ├── qdrant.ts       # gRPC client, findNeighbors(vector) → neighbors[5]
│   │   └── types.ts        # interfaces FraudRequest, Neighbor, NormalizationConfig
│   ├── tsconfig.json
│   ├── package.json
│   └── Dockerfile
├── qdrant/
│   ├── scripts/
│   │   ├── build-index.ts  # cria coleção, insere vetores, aguarda índice
│   │   └── parse-refs.ts   # streaming parser do references.json.gz
│   └── Dockerfile
├── nginx/
│   └── nginx.conf
└── docker-compose.yml
```

### TypeScript — decisões de configuração

- Node.js 22 suporta `--experimental-strip-types`: roda arquivos `.ts` diretamente, sem compilação
- Sem `tsc` no Dockerfile, sem `dist/`, sem multi-stage para TypeScript — Dockerfile idêntico ao de um projeto JS
- Type-checking feito localmente via `tsc --noEmit` (não bloqueia a imagem de produção)
- `strict: true` no `tsconfig.json` — garante que campos opcionais como `last_transaction` sejam tratados explicitamente

### Dockerfile da API

```dockerfile
FROM node:22-alpine
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY src/ ./src/
EXPOSE 3000
CMD ["node", "--experimental-strip-types", "src/server.ts"]
```

---

## 8. Endpoints

### GET /ready

Retorna `200 OK` quando o Qdrant está acessível e a coleção `txns` existe.  
Retorna `503` enquanto o Qdrant ainda está inicializando.

### POST /fraud-score

**Request:**
```json
{
  "id": "tx-123",
  "transaction": { "amount": 384.88, "installments": 3, "requested_at": "2024-01-15T10:30:00Z" },
  "customer": { "avg_amount": 769.76, "tx_count_24h": 3, "known_merchants": ["MERC-001"] },
  "merchant": { "id": "MERC-002", "mcc": "5912", "avg_amount": 298.95 },
  "terminal": { "is_online": false, "card_present": true, "km_from_home": 13.7 },
  "last_transaction": { "timestamp": "2024-01-15T08:00:00Z", "km_from_current": 18.8 }
}
```

**Response:**
```json
{ "approved": true, "fraud_score": 0.2 }
```

---

## 9. Performance Esperada

| Métrica | Estimativa |
|---------|-----------|
| Normalização (JS) | < 0.1 ms |
| Busca HNSW (Qdrant) | < 1 ms |
| Overhead rede Docker | ~0.3 ms |
| **p99 end-to-end** | **~2–5 ms** |
| Score de latência esperado | **+2.000 pts** |
| Recall estimado (int8 + m=4) | ~95–97% |
| Taxa de erro estimada | ~3–5% (bem abaixo dos 15%) |

---

## 10. Alavancas de Tuning

| Problema | Ajuste |
|----------|--------|
| p99 > 5 ms | Reduzir `ef` na query (128 → 64 → 32) |
| Recall < 95% | Aumentar `m` de 4 → 6 (+48 MB RAM no Qdrant) |
| RAM Qdrant estourando | Confirmar `on_disk: true` nos vetores float32 |
| Node.js lento no startup | `mcc_risk` deve ser `Map`, não objeto plano |
| Build muito lento | Aumentar batch size no script de inserção |

---

## 11. Restrições Atendidas

- [x] Porta 9999
- [x] Rede bridge (sem host/privileged)
- [x] Máximo 1.0 CPU total
- [x] Máximo 350 MB RAM total
- [x] Load balancer + 2 instâncias com round-robin
- [x] Imagens públicas linux/amd64
- [x] docker-compose.yml como entrypoint
- [x] Sem lookup pré-computado de fraudes (busca vetorial real no Qdrant)
- [x] Sem uso do payload de teste como referência
