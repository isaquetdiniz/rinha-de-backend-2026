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
    g_loaded = false;
    g_index  = IVFIndex{};   // reset completo antes de qualquer leitura

    std::ifstream f(path, std::ios::binary);
    if (!f) throw std::runtime_error("Cannot open: " + path);

    f.read(reinterpret_cast<char*>(&g_index.nlist),  4);
    f.read(reinterpret_cast<char*>(&g_index.ndim),   4);
    f.read(reinterpret_cast<char*>(&g_index.ntotal), 4);
    if (f.fail()) throw std::runtime_error("Truncated or empty file: " + path);

    g_index.centroids.resize(static_cast<size_t>(g_index.nlist) * g_index.ndim);
    f.read(reinterpret_cast<char*>(g_index.centroids.data()),
           static_cast<std::streamsize>(g_index.nlist) * g_index.ndim * sizeof(float));
    if (f.fail()) throw std::runtime_error("Truncated file (centroids): " + path);

    g_index.vectors.resize(g_index.nlist);
    g_index.labels.resize(g_index.nlist);

    for (int i = 0; i < g_index.nlist; i++) {
        int32_t sz;
        f.read(reinterpret_cast<char*>(&sz), 4);
        if (f.fail()) throw std::runtime_error("Truncated file (cluster size): " + path);
        g_index.vectors[i].resize(static_cast<size_t>(sz) * g_index.ndim);
        g_index.labels[i].resize(sz);
        f.read(reinterpret_cast<char*>(g_index.vectors[i].data()),
               static_cast<std::streamsize>(sz) * g_index.ndim * sizeof(int16_t));
        f.read(reinterpret_cast<char*>(g_index.labels[i].data()),
               static_cast<std::streamsize>(sz) * sizeof(int32_t));
        if (f.fail()) throw std::runtime_error("Truncated file (cluster data): " + path);
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
