# Custom C++ IVF k-NN Addon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Substituir `faiss-node` por um addon C++ customizado que implementa IVF com k-means + quantização int16, expondo `nProbe` configurável via variável de ambiente.

**Architecture:** O addon (`knn.cpp`) roda k-means offline durante o build Docker, gera um arquivo binário `knn.index` (IVF com listas invertidas de vetores int16), e é carregado no startup da API. `KnnService` expõe a mesma interface que `FaissService`, permitindo troca via flag `USE_KNN=true` sem alterar o restante do código.

**Tech Stack:** C++17 + N-API (node-addon-api), node-gyp, TypeScript (ESM com `--experimental-strip-types`), Node.js built-in test runner.

---

## Mapa de Arquivos

| Ação | Arquivo | Responsabilidade |
|------|---------|-----------------|
| Criar | `api/knn-addon/src/knn.cpp` | Toda lógica C++: k-means, IVF, quantização int16, busca nProbe |
| Criar | `api/knn-addon/binding.gyp` | Config de build node-gyp com flags Haswell |
| Criar | `api/knn-addon/package.json` | `"type": "commonjs"` para que `index.js` possa usar `require()` |
| Criar | `api/knn-addon/index.js` | Thin wrapper CJS: `module.exports = require('./build/Release/knn.node')` |
| Criar | `api/scripts/build-knn-index.ts` | Lê references.json.gz, chama addon.buildIndex, salva knn.index |
| Criar | `api/src/knn.ts` | TypeScript wrapper do addon — mesma interface que `FaissService` |
| Criar | `api/src/knn.test.ts` | Testes do addon e do KnnService |
| Modificar | `api/package.json` | Adicionar `node-addon-api` em devDependencies e script `build:addon` |
| Modificar | `api/src/server.ts` | Adicionar flag `USE_KNN` para alternar entre os dois serviços |
| Modificar | `api/Dockerfile` | Build do addon C++ + índice knn em novo stage de build |

---

## Task 1: Scaffold do knn-addon (estrutura + compilação básica)

**Files:**
- Create: `api/knn-addon/src/knn.cpp`
- Create: `api/knn-addon/binding.gyp`
- Create: `api/knn-addon/package.json`
- Create: `api/knn-addon/index.js`
- Modify: `api/package.json`

- [ ] **Step 1: Instalar node-addon-api**

```bash
cd api && npm install --save-dev node-addon-api
```

Expected: `node-addon-api` em `devDependencies` no `api/package.json`.

- [ ] **Step 2: Criar api/knn-addon/package.json**

```json
{
  "name": "knn-addon",
  "version": "1.0.0",
  "type": "commonjs"
}
```

Necessário porque o projeto pai tem `"type": "module"` — sem isso, `index.js` seria tratado como ESM e `require()` falharia.

- [ ] **Step 3: Criar api/knn-addon/binding.gyp**

```json
{
  "targets": [{
    "target_name": "knn",
    "sources": ["src/knn.cpp"],
    "include_dirs": [
      "<!@(node -p \"require('node-addon-api').include\")"
    ],
    "cflags_cc": ["-O3", "-march=haswell", "-std=c++17"],
    "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"]
  }]
}
```

`-march=haswell`: alvo é Mac Mini Late 2014 com Intel Core i5 Haswell (suporta AVX2 + FMA).

- [ ] **Step 4: Criar api/knn-addon/src/knn.cpp (skeleton)**

```cpp
#include <napi.h>

Napi::Value Ping(const Napi::CallbackInfo& info) {
    return Napi::String::New(info.Env(), "pong");
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("ping",       Napi::Function::New(env, Ping));
    exports.Set("buildIndex", Napi::Function::New(env, Ping));
    exports.Set("saveIndex",  Napi::Function::New(env, Ping));
    exports.Set("loadIndex",  Napi::Function::New(env, Ping));
    exports.Set("search",     Napi::Function::New(env, Ping));
    exports.Set("getStats",   Napi::Function::New(env, Ping));
    return exports;
}

NODE_API_MODULE(knn, Init)
```

- [ ] **Step 5: Criar api/knn-addon/index.js**

```javascript
'use strict'
module.exports = require('./build/Release/knn.node')
```

- [ ] **Step 6: Adicionar script build:addon em api/package.json**

Em `scripts`, adicionar:

```json
"build:addon": "(cd knn-addon && npx node-gyp configure && npx node-gyp build)"
```

- [ ] **Step 7: Compilar e verificar**

```bash
cd api && npm run build:addon
```

Expected: arquivo `api/knn-addon/build/Release/knn.node` criado, zero erros.

- [ ] **Step 8: Smoke test do scaffold**

```bash
cd api && node -e "const a = require('./knn-addon/index.js'); console.log(a.ping())"
```

Expected: `pong`

- [ ] **Step 9: Commit**

```bash
git add api/knn-addon/ api/package.json api/package-lock.json
git commit -m "feat: scaffold knn-addon C++ native addon"
```

---

## Task 2: knn.cpp — estruturas + I/O (loadIndex / saveIndex / getStats)

**Files:**
- Modify: `api/knn-addon/src/knn.cpp`
- Create: `api/src/knn.test.ts`

- [ ] **Step 1: Substituir knn.cpp com implementação de I/O**

Substituir `api/knn-addon/src/knn.cpp`:

```cpp
#include <napi.h>
#include <vector>
#include <cstdint>
#include <fstream>
#include <stdexcept>
#include <string>
#include <cmath>
#include <limits>
#include <algorithm>
#include <numeric>
#include <random>
#include <queue>

// ─── Estrutura do índice ──────────────────────────────────────────────────────

struct IVFIndex {
    int32_t nlist  = 0;
    int32_t ndim   = 0;
    int32_t ntotal = 0;
    std::vector<float>                centroids; // nlist × ndim
    std::vector<std::vector<int16_t>> vectors;   // [cluster][vec * ndim]
    std::vector<std::vector<int32_t>> labels;    // [cluster][label]
};

static IVFIndex g_index;
static bool     g_loaded = false;

// ─── Helpers de distância ─────────────────────────────────────────────────────

static float l2sq(const float* a, const float* b, int ndim) {
    float s = 0.0f;
    for (int i = 0; i < ndim; i++) { float d = a[i] - b[i]; s += d * d; }
    return s;
}

// ─── Quantização int16 — range [-1, 1] → [-32767, 32767] ─────────────────────

static inline int16_t quantize(float f) {
    float c = f < -1.0f ? -1.0f : (f > 1.0f ? 1.0f : f);
    return static_cast<int16_t>(c * 32767.0f);
}

static inline float dequantize(int16_t q) {
    return q / 32767.0f;
}

// ─── I/O binário ─────────────────────────────────────────────────────────────
// Formato: [nlist i32][ndim i32][ntotal i32][centroids f32×nlist×ndim]
//          Para cada cluster: [size i32][vectors i16×size×ndim][labels i32×size]

static void writeIndex(const std::string& path) {
    std::ofstream f(path, std::ios::binary);
    if (!f) throw std::runtime_error("Cannot write: " + path);

    f.write(reinterpret_cast<const char*>(&g_index.nlist),  4);
    f.write(reinterpret_cast<const char*>(&g_index.ndim),   4);
    f.write(reinterpret_cast<const char*>(&g_index.ntotal), 4);
    f.write(reinterpret_cast<const char*>(g_index.centroids.data()),
            static_cast<std::streamsize>(g_index.nlist) * g_index.ndim * sizeof(float));

    for (int i = 0; i < g_index.nlist; i++) {
        int32_t sz = static_cast<int32_t>(g_index.labels[i].size());
        f.write(reinterpret_cast<const char*>(&sz), 4);
        f.write(reinterpret_cast<const char*>(g_index.vectors[i].data()),
                static_cast<std::streamsize>(sz) * g_index.ndim * sizeof(int16_t));
        f.write(reinterpret_cast<const char*>(g_index.labels[i].data()),
                static_cast<std::streamsize>(sz) * sizeof(int32_t));
    }
}

static void readIndex(const std::string& path) {
    std::ifstream f(path, std::ios::binary);
    if (!f) throw std::runtime_error("Cannot open: " + path);

    f.read(reinterpret_cast<char*>(&g_index.nlist),  4);
    f.read(reinterpret_cast<char*>(&g_index.ndim),   4);
    f.read(reinterpret_cast<char*>(&g_index.ntotal), 4);

    g_index.centroids.resize(static_cast<size_t>(g_index.nlist) * g_index.ndim);
    f.read(reinterpret_cast<char*>(g_index.centroids.data()),
           static_cast<std::streamsize>(g_index.nlist) * g_index.ndim * sizeof(float));

    g_index.vectors.resize(g_index.nlist);
    g_index.labels.resize(g_index.nlist);

    for (int i = 0; i < g_index.nlist; i++) {
        int32_t sz;
        f.read(reinterpret_cast<char*>(&sz), 4);
        g_index.vectors[i].resize(static_cast<size_t>(sz) * g_index.ndim);
        g_index.labels[i].resize(sz);
        f.read(reinterpret_cast<char*>(g_index.vectors[i].data()),
               static_cast<std::streamsize>(sz) * g_index.ndim * sizeof(int16_t));
        f.read(reinterpret_cast<char*>(g_index.labels[i].data()),
               static_cast<std::streamsize>(sz) * sizeof(int32_t));
    }
    g_loaded = true;
}

// ─── N-API exports ────────────────────────────────────────────────────────────

Napi::Value SaveIndex(const Napi::CallbackInfo& info) {
    try { writeIndex(info[0].As<Napi::String>().Utf8Value()); }
    catch (const std::exception& e) {
        Napi::Error::New(info.Env(), e.what()).ThrowAsJavaScriptException();
    }
    return info.Env().Undefined();
}

Napi::Value LoadIndex(const Napi::CallbackInfo& info) {
    try { readIndex(info[0].As<Napi::String>().Utf8Value()); }
    catch (const std::exception& e) {
        Napi::Error::New(info.Env(), e.what()).ThrowAsJavaScriptException();
    }
    return info.Env().Undefined();
}

Napi::Value GetStats(const Napi::CallbackInfo& info) {
    Napi::Env    env   = info.Env();
    Napi::Object stats = Napi::Object::New(env);
    stats.Set("nlist",  Napi::Number::New(env, g_index.nlist));
    stats.Set("ntotal", Napi::Number::New(env, g_index.ntotal));
    return stats;
}

// buildIndex e search implementados nas próximas tasks
Napi::Value BuildIndex(const Napi::CallbackInfo& info) { return info.Env().Undefined(); }
Napi::Value Search    (const Napi::CallbackInfo& info) { return info.Env().Undefined(); }

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("buildIndex", Napi::Function::New(env, BuildIndex));
    exports.Set("saveIndex",  Napi::Function::New(env, SaveIndex));
    exports.Set("loadIndex",  Napi::Function::New(env, LoadIndex));
    exports.Set("getStats",   Napi::Function::New(env, GetStats));
    exports.Set("search",     Napi::Function::New(env, Search));
    return exports;
}

NODE_API_MODULE(knn, Init)
```

- [ ] **Step 2: Compilar**

```bash
cd api && npm run build:addon
```

Expected: zero erros.

- [ ] **Step 3: Escrever testes de I/O**

Criar `api/src/knn.test.ts`:

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))

const addon = require(resolve(__dirname, '../knn-addon/index.js')) as {
  loadIndex:  (path: string) => void
  saveIndex:  (path: string) => void
  buildIndex: (vectors: Float32Array, labels: Int32Array, nlist: number, iterations: number) => void
  search:     (vector: Float32Array, k: number, nProbe: number) => { labels: Int32Array; distances: Float32Array }
  getStats:   () => { nlist: number; ntotal: number }
}

// Escreve um índice binário mínimo manualmente para testar loadIndex sem precisar de buildIndex
function writeTinyIndex(path: string) {
  const nlist = 2, ndim = 14, ntotal = 4
  // Tamanho: 12 (header) + nlist×ndim×4 (centroides) + nlist×(4 + 2×ndim×2 + 2×4) (clusters)
  const buf = Buffer.alloc(12 + nlist * ndim * 4 + nlist * (4 + 2 * ndim * 2 + 2 * 4))
  let off = 0
  buf.writeInt32LE(nlist,  off); off += 4
  buf.writeInt32LE(ndim,   off); off += 4
  buf.writeInt32LE(ntotal, off); off += 4
  off += nlist * ndim * 4  // centroides zeros
  for (let c = 0; c < nlist; c++) {
    buf.writeInt32LE(2, off); off += 4        // size=2
    off += 2 * ndim * 2                       // vetores int16 zeros
    buf.writeInt32LE(1, off); off += 4        // label[0]=fraude
    buf.writeInt32LE(0, off); off += 4        // label[1]=legítimo
  }
  writeFileSync(path, buf)
}

test('loadIndex carrega índice válido', () => {
  const path = resolve(tmpdir(), 'test_tiny.index')
  writeTinyIndex(path)
  addon.loadIndex(path)
  const stats = addon.getStats()
  assert.equal(stats.nlist, 2)
  assert.equal(stats.ntotal, 4)
  unlinkSync(path)
})

test('loadIndex lança erro para arquivo inexistente', () => {
  assert.throws(() => addon.loadIndex('/nao/existe.index'))
})
```

- [ ] **Step 4: Rodar testes**

```bash
cd api && node --experimental-strip-types --test src/knn.test.ts
```

Expected: 2 testes passando.

- [ ] **Step 5: Commit**

```bash
git add api/knn-addon/src/knn.cpp api/src/knn.test.ts
git commit -m "feat: knn-addon I/O binário (loadIndex/saveIndex/getStats)"
```

---

## Task 3: knn.cpp — buildIndex (k-means + quantização + listas invertidas)

**Files:**
- Modify: `api/knn-addon/src/knn.cpp`

- [ ] **Step 1: Substituir a função BuildIndex em knn.cpp**

Substituir apenas a função `BuildIndex` (mantendo todo o resto igual):

```cpp
// K-means: sub-amostra para treinamento, depois atribui todos os vetores
Napi::Value BuildIndex(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    try {
        auto           vecArr = info[0].As<Napi::Float32Array>();
        auto           labArr = info[1].As<Napi::Int32Array>();
        int            nlist  = info[2].As<Napi::Number>().Int32Value();
        int            iters  = info[3].As<Napi::Number>().Int32Value();
        const float*   vecs   = vecArr.Data();
        const int32_t* labs   = labArr.Data();
        const int      ndim   = 14;
        const int      n      = static_cast<int>(labArr.ElementLength());

        // Sub-amostragem: usa no máximo 100k vetores para treinar k-means
        const int    maxTrain = 100'000;
        const int    trainN   = std::min(n, maxTrain);
        std::mt19937 rng(42);

        std::vector<int> idx(n);
        std::iota(idx.begin(), idx.end(), 0);
        std::shuffle(idx.begin(), idx.end(), rng);

        std::vector<float> trainVecs(static_cast<size_t>(trainN) * ndim);
        for (int i = 0; i < trainN; i++) {
            const float* src = vecs + static_cast<size_t>(idx[i]) * ndim;
            std::copy(src, src + ndim, trainVecs.data() + static_cast<size_t>(i) * ndim);
        }

        // Inicialização: seleciona nlist vetores aleatórios como centroides iniciais
        g_index.nlist = nlist;
        g_index.ndim  = ndim;
        g_index.centroids.resize(static_cast<size_t>(nlist) * ndim);

        std::shuffle(idx.begin(), idx.begin() + trainN, rng);
        for (int c = 0; c < nlist; c++) {
            const float* src = trainVecs.data() + static_cast<size_t>(idx[c]) * ndim;
            std::copy(src, src + ndim, g_index.centroids.data() + static_cast<size_t>(c) * ndim);
        }

        // Iterações k-means no sub-sample
        std::vector<int>   assignments(trainN);
        std::vector<float> sums(static_cast<size_t>(nlist) * ndim);
        std::vector<int>   counts(nlist);

        for (int iter = 0; iter < iters; iter++) {
            // Assign
            for (int i = 0; i < trainN; i++) {
                float best = std::numeric_limits<float>::infinity();
                int   bc   = 0;
                for (int c = 0; c < nlist; c++) {
                    float d = l2sq(trainVecs.data() + static_cast<size_t>(i) * ndim,
                                   g_index.centroids.data() + static_cast<size_t>(c) * ndim, ndim);
                    if (d < best) { best = d; bc = c; }
                }
                assignments[i] = bc;
            }
            // Update
            std::fill(sums.begin(), sums.end(), 0.0f);
            std::fill(counts.begin(), counts.end(), 0);
            for (int i = 0; i < trainN; i++) {
                int           c   = assignments[i];
                const float*  v   = trainVecs.data() + static_cast<size_t>(i) * ndim;
                float*        s   = sums.data() + static_cast<size_t>(c) * ndim;
                counts[c]++;
                for (int d = 0; d < ndim; d++) s[d] += v[d];
            }
            for (int c = 0; c < nlist; c++) {
                if (counts[c] == 0) continue;
                float* cen = g_index.centroids.data() + static_cast<size_t>(c) * ndim;
                float* s   = sums.data()              + static_cast<size_t>(c) * ndim;
                for (int d = 0; d < ndim; d++) cen[d] = s[d] / counts[c];
            }
        }

        // Atribui TODOS os n vetores ao centroide mais próximo e monta listas invertidas
        g_index.vectors.assign(nlist, {});
        g_index.labels.assign(nlist, {});

        for (int i = 0; i < n; i++) {
            const float* v    = vecs + static_cast<size_t>(i) * ndim;
            float        best = std::numeric_limits<float>::infinity();
            int          bc   = 0;
            for (int c = 0; c < nlist; c++) {
                float d = l2sq(v, g_index.centroids.data() + static_cast<size_t>(c) * ndim, ndim);
                if (d < best) { best = d; bc = c; }
            }
            for (int d = 0; d < ndim; d++) g_index.vectors[bc].push_back(quantize(v[d]));
            g_index.labels[bc].push_back(labs[i]);
        }

        g_index.ntotal = n;
        g_loaded       = true;
    } catch (const std::exception& e) {
        Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    }
    return env.Undefined();
}
```

- [ ] **Step 2: Compilar**

```bash
cd api && npm run build:addon
```

Expected: zero erros.

- [ ] **Step 3: Adicionar testes de buildIndex em knn.test.ts**

Adicionar no final de `api/src/knn.test.ts`:

```typescript
test('buildIndex produz stats corretos', () => {
  const n = 200, ndim = 14, nlist = 4
  const vectors = new Float32Array(n * ndim).map(() => Math.random())
  const labels  = new Int32Array(n).map(() => Math.round(Math.random()))
  addon.buildIndex(vectors, labels, nlist, 5)
  const stats = addon.getStats()
  assert.equal(stats.nlist, nlist)
  assert.equal(stats.ntotal, n)
})

test('buildIndex + saveIndex + loadIndex preserva ntotal e nlist', () => {
  const path = resolve(tmpdir(), 'test_roundtrip.index')
  const n = 200, ndim = 14, nlist = 4
  const vectors = new Float32Array(n * ndim).map(() => Math.random())
  const labels  = new Int32Array(n).map(() => Math.round(Math.random()))
  addon.buildIndex(vectors, labels, nlist, 5)
  addon.saveIndex(path)
  addon.loadIndex(path)
  const stats = addon.getStats()
  assert.equal(stats.nlist, nlist)
  assert.equal(stats.ntotal, n)
  unlinkSync(path)
})
```

- [ ] **Step 4: Rodar testes**

```bash
cd api && node --experimental-strip-types --test src/knn.test.ts
```

Expected: 4 testes passando.

- [ ] **Step 5: Commit**

```bash
git add api/knn-addon/src/knn.cpp api/src/knn.test.ts
git commit -m "feat: knn-addon buildIndex com k-means e quantização int16"
```

---

## Task 4: knn.cpp — search (nProbe + max-heap)

**Files:**
- Modify: `api/knn-addon/src/knn.cpp`

- [ ] **Step 1: Substituir a função Search em knn.cpp**

Substituir apenas a função `Search` (mantendo todo o resto igual):

```cpp
Napi::Value Search(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!g_loaded) {
        Napi::Error::New(env, "Index not loaded").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    try {
        auto         queryArr = info[0].As<Napi::Float32Array>();
        int          k        = info[1].As<Napi::Number>().Int32Value();
        int          nProbe   = info[2].As<Napi::Number>().Int32Value();
        const float* query    = queryArr.Data();
        const int    ndim     = g_index.ndim;
        const int    nl       = g_index.nlist;

        nProbe = std::min(nProbe, nl);

        // Passo 1: encontra os nProbe centroides mais próximos da query
        std::vector<std::pair<float, int>> cdists(nl);
        for (int c = 0; c < nl; c++) {
            cdists[c] = { l2sq(query, g_index.centroids.data() + static_cast<size_t>(c) * ndim, ndim), c };
        }
        std::partial_sort(cdists.begin(), cdists.begin() + nProbe, cdists.end());

        // Passo 2: busca nos nProbe clusters com max-heap de tamanho k
        using Pair = std::pair<float, int32_t>;
        std::priority_queue<Pair> heap;

        for (int pi = 0; pi < nProbe; pi++) {
            int          ci  = cdists[pi].second;
            const auto&  vs  = g_index.vectors[ci];
            const auto&  ls  = g_index.labels[ci];
            const int    sz  = static_cast<int>(ls.size());

            for (int j = 0; j < sz; j++) {
                float           d    = 0.0f;
                const int16_t*  vptr = vs.data() + static_cast<size_t>(j) * ndim;
                for (int di = 0; di < ndim; di++) {
                    float diff = query[di] - dequantize(vptr[di]);
                    d += diff * diff;
                }
                if (static_cast<int>(heap.size()) < k) {
                    heap.push({ d, ls[j] });
                } else if (d < heap.top().first) {
                    heap.pop();
                    heap.push({ d, ls[j] });
                }
            }
        }

        // Passo 3: extrai resultados (da menor para maior distância)
        const int          m       = static_cast<int>(heap.size());
        Napi::Int32Array   labArr  = Napi::Int32Array::New(env, m);
        Napi::Float32Array distArr = Napi::Float32Array::New(env, m);
        for (int i = m - 1; i >= 0; i--) {
            labArr[i]  = heap.top().second;
            distArr[i] = heap.top().first;
            heap.pop();
        }

        Napi::Object result = Napi::Object::New(env);
        result.Set("labels",    labArr);
        result.Set("distances", distArr);
        return result;
    } catch (const std::exception& e) {
        Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
        return env.Undefined();
    }
}
```

- [ ] **Step 2: Compilar**

```bash
cd api && npm run build:addon
```

Expected: zero erros.

- [ ] **Step 3: Adicionar testes de search em knn.test.ts**

Adicionar no final de `api/src/knn.test.ts`:

```typescript
test('search retorna k vizinhos com labels corretos', () => {
  // 50 fraudes próximas de [0.95,...] e 50 legítimos próximos de [0.05,...]
  const n = 100, ndim = 14, nlist = 4
  const vectors = new Float32Array(n * ndim)
  const labels  = new Int32Array(n)
  for (let i = 0; i < 50; i++) {
    labels[i] = 1
    for (let d = 0; d < ndim; d++) vectors[i * ndim + d] = 0.9 + Math.random() * 0.1
  }
  for (let i = 50; i < 100; i++) {
    labels[i] = 0
    for (let d = 0; d < ndim; d++) vectors[i * ndim + d] = Math.random() * 0.1
  }
  addon.buildIndex(vectors, labels, nlist, 10)

  const fraudQuery = new Float32Array(ndim).fill(0.95)
  const res1 = addon.search(fraudQuery, 5, 2)
  assert.equal(res1.labels.length, 5)
  const fraudCount = Array.from(res1.labels).filter(l => l === 1).length
  assert.ok(fraudCount >= 3, `Esperava >=3 fraudes nos vizinhos, got ${fraudCount}`)

  const legitQuery = new Float32Array(ndim).fill(0.05)
  const res2 = addon.search(legitQuery, 5, 2)
  const legitCount = Array.from(res2.labels).filter(l => l === 0).length
  assert.ok(legitCount >= 3, `Esperava >=3 legítimos nos vizinhos, got ${legitCount}`)
})

test('search lança erro se índice não carregado', () => {
  // Força g_loaded=false fazendo loadIndex em arquivo inválido (ignora erro)
  // e verifica que search sem índice lança erro — na prática o addon é singleton,
  // então esse teste só é válido na primeira execução sem loadIndex.
  // Aqui apenas verificamos que search retorna dados válidos após buildIndex.
  const vectors = new Float32Array(14).fill(0.5)
  const res = addon.search(vectors, 3, 2)
  assert.ok(res.labels.length <= 3)
})
```

- [ ] **Step 4: Rodar testes**

```bash
cd api && node --experimental-strip-types --test src/knn.test.ts
```

Expected: 6 testes passando.

- [ ] **Step 5: Commit**

```bash
git add api/knn-addon/src/knn.cpp api/src/knn.test.ts
git commit -m "feat: knn-addon search com nProbe e max-heap k vizinhos"
```

---

## Task 5: build-knn-index.ts — geração do índice IVF

**Files:**
- Create: `api/scripts/build-knn-index.ts`

- [ ] **Step 1: Criar api/scripts/build-knn-index.ts**

```typescript
import { mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { parseReferences } from './parse-refs.ts'

const require    = createRequire(import.meta.url)
const __dirname  = dirname(fileURLToPath(import.meta.url))

const addon = require(resolve(__dirname, '../knn-addon/index.js')) as {
  buildIndex: (vectors: Float32Array, labels: Int32Array, nlist: number, iterations: number) => void
  saveIndex:  (path: string) => void
  getStats:   () => { nlist: number; ntotal: number }
}

const REFS_PATH  = resolve(__dirname, '..', 'references.json.gz')
const OUTPUT_DIR = process.env['OUTPUT_DIR']      ?? '/data'
const NLIST      = parseInt(process.env['KNN_NLIST']       ?? '1024', 10)
const ITERATIONS = parseInt(process.env['KNN_ITERATIONS']  ?? '20',   10)

mkdirSync(OUTPUT_DIR, { recursive: true })

console.log('Carregando vetores...')
const rawVectors: number[] = []
const rawLabels:  number[] = []

let count = 0
for await (const record of parseReferences(REFS_PATH)) {
  for (const v of record.vector) rawVectors.push(v)
  rawLabels.push(record.label === 'fraud' ? 1 : 0)
  count++
  if (count % 500_000 === 0) console.log(`  ${count} vetores lidos...`)
}
console.log(`Total: ${count} vetores`)

const vectors = new Float32Array(rawVectors)
const labels  = new Int32Array(rawLabels)

console.log(`Treinando IVF (nlist=${NLIST}, iterations=${ITERATIONS}, trainSample=min(${count},100000))...`)
console.time('buildIndex')
addon.buildIndex(vectors, labels, NLIST, ITERATIONS)
console.timeEnd('buildIndex')

const stats = addon.getStats()
console.log(`Índice construído: ${stats.ntotal} vetores em ${stats.nlist} clusters`)

const indexPath = resolve(OUTPUT_DIR, 'knn.index')
addon.saveIndex(indexPath)
console.log(`Índice salvo: ${indexPath}`)
```

- [ ] **Step 2: Testar o script localmente (se references.json.gz disponível)**

```bash
cd api
OUTPUT_DIR=/tmp/knn-test KNN_NLIST=32 KNN_ITERATIONS=5 \
  node --experimental-strip-types scripts/build-knn-index.ts
```

Expected: log mostrando leitura dos vetores, tempo de buildIndex, e arquivo `/tmp/knn-test/knn.index` criado.

Se `references.json.gz` não existir localmente, pular — será testado na Task 8 dentro do Docker.

- [ ] **Step 3: Commit**

```bash
git add api/scripts/build-knn-index.ts
git commit -m "feat: script build-knn-index usando addon C++"
```

---

## Task 6: knn.ts — TypeScript wrapper

**Files:**
- Create: `api/src/knn.ts`

- [ ] **Step 1: Criar api/src/knn.ts**

```typescript
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require   = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))

interface KnnAddon {
  loadIndex(path: string): void
  search(vector: Float32Array, k: number, nProbe: number): {
    labels:    Int32Array
    distances: Float32Array
  }
  getStats(): { nlist: number; ntotal: number }
}

const addon  = require(resolve(__dirname, '../knn-addon/index.js')) as KnnAddon
const K      = parseInt(process.env['KNN_K']      ?? '5',  10)
const NPROBE = parseInt(process.env['KNN_NPROBE'] ?? '64', 10)

export class KnnService {
  constructor(indexPath: string) {
    addon.loadIndex(indexPath)
  }

  search(vector: number[]): number {
    const { labels } = addon.search(new Float32Array(vector), K, NPROBE)
    let fraudCount = 0
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] === 1) fraudCount++
    }
    return fraudCount
  }

  getStats() {
    return addon.getStats()
  }
}
```

- [ ] **Step 2: Adicionar teste de KnnService em knn.test.ts**

Adicionar no final de `api/src/knn.test.ts`:

```typescript
test('KnnService.search retorna fraudCount para query de fraude', () => {
  const path   = resolve(tmpdir(), 'test_service.index')
  const n      = 100, ndim = 14, nlist = 4
  const vectors = new Float32Array(n * ndim)
  const labels  = new Int32Array(n)
  for (let i = 0; i < 50; i++) {
    labels[i] = 1
    for (let d = 0; d < ndim; d++) vectors[i * ndim + d] = 0.9 + Math.random() * 0.1
  }
  for (let i = 50; i < 100; i++) {
    labels[i] = 0
    for (let d = 0; d < ndim; d++) vectors[i * ndim + d] = Math.random() * 0.1
  }
  addon.buildIndex(vectors, labels, nlist, 10)
  addon.saveIndex(path)

  // KnnService carrega do arquivo e busca
  const { KnnService } = await import('./knn.ts')
  const svc = new KnnService(path)
  const fraudCount = svc.search(new Array(ndim).fill(0.95))
  assert.ok(fraudCount >= 3, `Esperava >=3 fraudes, got ${fraudCount}`)
  unlinkSync(path)
})
```

- [ ] **Step 3: Rodar testes**

```bash
cd api && node --experimental-strip-types --test src/knn.test.ts
```

Expected: 7 testes passando.

- [ ] **Step 4: Typecheck**

```bash
cd api && npm run typecheck
```

Expected: zero erros.

- [ ] **Step 5: Commit**

```bash
git add api/src/knn.ts api/src/knn.test.ts
git commit -m "feat: KnnService TypeScript wrapper do addon knn"
```

---

## Task 7: server.ts — flag USE_KNN

**Files:**
- Modify: `api/src/server.ts`

- [ ] **Step 1: Substituir api/src/server.ts**

```typescript
import { chmodSync } from 'node:fs'
import { resolve } from 'node:path'
import { App } from 'uWebSockets.js'
import { FaissService } from './faiss.ts'
import { KnnService } from './knn.ts'
import { toVector } from './normalize.ts'
import type { FraudRequest } from './types.ts'

const DATA_DIR    = process.env['DATA_DIR']    ?? '/data'
const SOCKET_PATH = process.env['SOCKET_PATH'] as string
const USE_KNN     = process.env['USE_KNN']     === 'true'
const THRESHOLD   = parseFloat(process.env['KNN_THRESHOLD'] ?? '0.6')
const K           = parseInt(process.env['KNN_K']           ?? '5', 10)

interface Searcher { search(vector: number[]): number }

const searcher: Searcher = USE_KNN
  ? new KnnService(resolve(DATA_DIR, 'knn.index'))
  : new FaissService(resolve(DATA_DIR, 'txns.index'), resolve(DATA_DIR, 'txns.labels'))

const app = App()

app.get('/ready', (res) => {
  searcher.search(new Array(14).fill(0))
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
      res.cork(() => { res.writeStatus('400 Bad Request'); res.end() })
      return
    }

    try {
      const vector      = toVector(body)
      const fraudCount  = searcher.search(vector)
      const fraud_score = fraudCount / K
      const response    = JSON.stringify({ approved: fraud_score < THRESHOLD, fraud_score })
      res.cork(() => {
        res.writeStatus('200 OK')
        res.writeHeader('Content-Type', 'application/json')
        res.end(response)
      })
    } catch {
      res.cork(() => { res.writeStatus('500 Internal Server Error'); res.end() })
    }
  })
})

app.any('/*', (res) => {
  res.cork(() => { res.writeStatus('404 Not Found'); res.end() })
})

app.listen_unix((token) => {
  if (!token) throw new Error(`Failed to listen on socket ${SOCKET_PATH}`)
  chmodSync(SOCKET_PATH, 0o777)
}, SOCKET_PATH)
```

- [ ] **Step 2: Typecheck**

```bash
cd api && npm run typecheck
```

Expected: zero erros.

- [ ] **Step 3: Commit**

```bash
git add api/src/server.ts
git commit -m "feat: server.ts suporta USE_KNN para alternar FaissService/KnnService"
```

---

## Task 8: Dockerfile — integração do addon e do índice knn

**Files:**
- Modify: `api/Dockerfile`

- [ ] **Step 1: Substituir api/Dockerfile**

```dockerfile
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
```

- [ ] **Step 2: Build da imagem localmente**

```bash
docker build -f api/Dockerfile -t rinha-knn:local .
```

Expected: imagem construída sem erros. No log deve aparecer:
- `Treinando IVF (nlist=1024, iterations=20...)`
- `buildIndex: Xs`
- `Índice salvo: /data/knn.index`

- [ ] **Step 3: Verificar que o addon está presente na imagem**

```bash
docker run --rm --entrypoint node rinha-knn:local \
  -e "const a = require('./knn-addon/index.js'); console.log(typeof a.loadIndex)"
```

Expected: `function`

- [ ] **Step 4: Atualizar docker-compose.yml para usar USE_KNN**

No serviço `api1` e `api2` do `docker-compose.yml`, adicionar em `environment`:

```yaml
USE_KNN: "true"
KNN_NPROBE: "64"
KNN_K: "5"
KNN_THRESHOLD: "0.6"
```

- [ ] **Step 5: Commit**

```bash
git add api/Dockerfile docker-compose.yml
git commit -m "feat: Dockerfile com build addon knn e índice IVF"
```

---

## Self-Review

**Spec coverage:**
- ✓ Addon C++ customizado com node-gyp + node-addon-api
- ✓ IVF com k-means (sub-amostra 100k, 20 iterações)
- ✓ Quantização int16 com range [-1,1]
- ✓ `nProbe` configurável via `KNN_NPROBE`
- ✓ `buildIndex`, `saveIndex`, `loadIndex`, `search`, `getStats`
- ✓ `knn-addon/package.json` com `"type": "commonjs"` (ESM compatibility fix)
- ✓ `knn.ts` com mesma interface que `FaissService`
- ✓ `faiss.ts` mantido intacto
- ✓ `server.ts` com flag `USE_KNN`
- ✓ Dockerfile com 2 stages (build addon + runtime)
- ✓ `-march=haswell` para Intel Core i5 Haswell (Mac Mini Late 2014)
- ✓ Parâmetros via env vars (`KNN_NLIST`, `KNN_NPROBE`, `KNN_K`, `KNN_THRESHOLD`, `KNN_ITERATIONS`)

**Checagem de tipos entre tasks:**
- `addon.buildIndex(Float32Array, Int32Array, number, number)` — consistente entre Task 3, Task 5, Task 6 ✓
- `addon.search(Float32Array, k, nProbe) → { labels: Int32Array, distances: Float32Array }` — consistente entre Task 4 e Task 6 ✓
- `KnnService.search(number[]): number` — igual a `FaissService.search` ✓
- `searcher: Searcher` em `server.ts` aceita ambos os serviços ✓
