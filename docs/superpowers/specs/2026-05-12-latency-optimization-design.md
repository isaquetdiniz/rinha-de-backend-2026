# Design: Otimização de Latência — Fastify → uWebSockets.js

## Contexto

O backend da Rinha de Backend 2026 opera com p99 de 222ms sob carga de 900 req/s, com budget de CPU de 0.45 por instância. O gargalo identificado é o overhead de HTTP processing do Fastify (hooks, schema validation, serializers) consumindo CPU que poderia ir para o FAISS.

## Objetivo

Reduzir o p99 substituindo Fastify por uWebSockets.js, mantendo toda a lógica de negócio (FAISS, `toVector`) intacta.

## Escopo

- **Dentro do escopo:** `src/server.ts`, `package.json`
- **Fora do escopo:** nginx, docker-compose, Dockerfile, `faiss.ts`, `normalize.ts`, `types.ts`

## Arquitetura

### Dependência

```json
"uWebSockets.js": "github:uNetworking/uWebSockets.js#v20.51.0"
```

O pacote distribui binários pré-compilados por plataforma. O Dockerfile usa `node:22-bookworm-slim` (Linux x64 + Node 22) — binário compatível incluso, sem compilação adicional.

### Hot path — POST /fraud-score

```
onData (chunks) → concat buffer → JSON.parse → toVector → faiss.search → res.cork → res.end
```

- `res.cork()` é obrigatório no uWebSockets.js para máxima performance (agrupa writes em syscall único)
- `onAborted` deve ser registrado antes de qualquer operação assíncrona para evitar crash
- `onData(chunk, isLast)` acumula chunks; quando `isLast === true` o body está completo

### Endpoints

| Método | Rota | Comportamento |
|--------|------|---------------|
| GET | `/ready` | Executa `faiss.search` com vetor zerado, retorna 200 |
| POST | `/fraud-score` | Processa body, retorna `{ approved, fraud_score }` |
| * | qualquer outra | 404 |

### Tratamento de erros

- JSON inválido no body → 400
- Erro interno → 500
- Ambos usam `res.cork` para não crashar o processo

## Compatibilidade

- A interface de rede não muda: nginx continua fazendo proxy para `api1:3000` e `api2:3000` via HTTP/1.1
- O Dockerfile não muda: `CMD ["node", "--experimental-strip-types", "src/server.ts"]`
- A porta permanece 3000
