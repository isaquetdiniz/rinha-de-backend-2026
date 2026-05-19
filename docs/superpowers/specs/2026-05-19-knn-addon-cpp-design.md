# Custom C++ IVF k-NN Addon — Design Spec

**Data:** 2026-05-19
**Contexto:** Rinha de Backend 2026 — substituir `faiss-node` por addon C++ customizado com IVF + quantização int16, para aprender o processo e ter controle total sobre `nProbe` e parâmetros de busca.

---

## Motivação

O `faiss-node` atual usa `IndexFlatL2` (brute-force), sem controle sobre `nProbe`. Com 3M vetores de referência e 14 dimensões, brute-force é inviável em memória (168MB por instância, limite de 170MB). A solução é um IVF (Inverted File Index) próprio com quantização int16: reduz memória para ~96MB por instância e permite configurar a precisão via `nProbe`.

---

## Arquitetura

### Estrutura de arquivos

```
api/
├── knn-addon/
│   ├── src/
│   │   └── knn.cpp          # IVF + quantização int16 + busca com nProbe
│   ├── binding.gyp          # config de build node-gyp
│   └── index.js             # thin wrapper: module.exports = require('./build/Release/knn.node')
├── src/
│   ├── faiss.ts             # mantido intacto (fallback)
│   ├── knn.ts               # novo wrapper TypeScript do addon
│   └── server.ts            # troca import no final (via flag USE_KNN)
└── scripts/
    └── build-knn-index.ts   # gera knn.index a partir de references.json.gz
```

### Fluxo em runtime

```
POST /fraud-score
  → normalize.ts (14 features → Float32Array)
  → knn.ts → addon.search(vector, k, nProbe)
  → knn.cpp: encontra nProbe centroides mais próximos
            → percorre listas invertidas dessas células
            → max-heap de k vizinhos
  → knn.ts: conta labels fraude → fraud_score = fraudCount / k
  → resposta HTTP
```

---

## Implementação C++

### Interface exposta ao TypeScript

```typescript
interface KnnAddon {
  loadIndex(path: string): void
  search(vector: Float32Array, k: number, nProbe: number): {
    labels: Int32Array      // 0=legítimo, 1=fraude
    distances: Float32Array // distâncias L2
  }
  getStats(): {
    nlist: number
    ntotal: number
  }
}
```

### Estrutura interna (knn.cpp)

```cpp
struct IVFIndex {
    int nlist;   // número de clusters (default: 2048)
    int ndim;    // 14 dimensões

    float* centroids;  // nlist × ndim floats — centroides em float32

    // listas invertidas: um array por cluster
    std::vector<std::vector<int16_t>> vectors;  // vetores quantizados
    std::vector<std::vector<int32_t>> labels;   // 0=legítimo, 1=fraude
};
```

### Quantização int16

- **Encode:** `int16_t q = static_cast<int16_t>(f * 32767.0f)` — mapeia [0,1] → [-32767, 32767]
- **Distância L2:** desquantiza on-the-fly — `float v = q / 32767.0f` — e calcula em float32
- **Precisão:** erro máximo por dimensão ≈ 0.0015% — desprezível para k-NN

### Algoritmo de busca

1. Calcula distância L2 do vetor query para todos os `nlist` centroides (em float32)
2. Seleciona os `nProbe` centroides mais próximos (partial sort)
3. Para cada lista invertida dos `nProbe` clusters: desquantiza vetores e calcula L2
4. Mantém max-heap de tamanho `k` com os menores distâncias encontrados
5. Retorna labels e distâncias dos `k` vizinhos

### Build system (binding.gyp)

```json
{
  "targets": [{
    "target_name": "knn",
    "sources": ["src/knn.cpp"],
    "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
    "cflags_cc": ["-O3", "-mavx2", "-std=c++17"],
    "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"]
  }]
}
```

---

## Build do índice (offline)

`scripts/build-knn-index.ts` — roda durante `docker build`:

1. Lê e descomprime `references.json.gz` → extrai vetores (float32) e labels
2. Roda k-means em TypeScript para gerar `nlist` centroides (pode usar várias iterações, é offline)
3. Atribui cada vetor ao centroide mais próximo → monta listas invertidas
4. Quantiza vetores para int16
5. Serializa em `knn.index` (formato binário simples: header + centroides + listas)

**Formato do arquivo `knn.index`:**
```
[4 bytes] nlist
[4 bytes] ndim
[4 bytes] ntotal
[nlist × ndim × 4 bytes] centroides (float32)
Para cada cluster i:
  [4 bytes] tamanho da lista
  [size × ndim × 2 bytes] vetores int16
  [size × 4 bytes] labels int32
```

---

## Memória estimada

| Componente | Tamanho |
|---|---|
| Centroides (2048 × 14 × 4B) | ~115 KB |
| Vetores int16 (3M × 14 × 2B) | ~84 MB |
| Labels int32 (3M × 4B) | ~12 MB |
| Overhead listas + processo Node | ~15 MB |
| **Total por instância** | **~111 MB** |

Cabe nos 170MB por instância com ~60MB de margem.

---

## Parâmetros configuráveis

| Variável | Default | Descrição |
|---|---|---|
| `KNN_NLIST` | `2048` | Número de clusters k-means |
| `KNN_NPROBE` | `64` | Clusters buscados por query |
| `KNN_K` | `5` | Vizinhos retornados |
| `KNN_THRESHOLD` | `0.6` | Limiar para classificar como fraude |
| `KNN_INDEX_PATH` | `/app/knn.index` | Caminho do índice serializado |

---

## Integração Docker

```dockerfile
# Dependências de build do addon
RUN apt-get install -y python3 make g++

# Build do addon C++
WORKDIR /app/api/knn-addon
RUN npm install node-addon-api
RUN node-gyp configure && node-gyp build

# Build do índice IVF
WORKDIR /app/api
RUN npx ts-node scripts/build-knn-index.ts
```

---

## Estratégia de transição sem risco

1. `faiss.ts` e `FaissService` permanecem intactos
2. `knn.ts` implementa a mesma interface que `FaissService`
3. `server.ts` usa `process.env.USE_KNN === 'true'` para escolher qual usar
4. Validar localmente com os dados de referência antes de trocar
5. Remover `faiss-node` do `package.json` somente após a submissão validada

---

## O que NÃO está no escopo

- GPU support
- HNSW ou outros tipos de índice
- Re-treinamento online do índice
- Persistência de estado entre instâncias
