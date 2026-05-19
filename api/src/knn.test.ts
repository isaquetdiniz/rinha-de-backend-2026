import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { createRequire } from 'node:module'
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

test('search retorna no máximo k vizinhos', () => {
  const vectors = new Float32Array(14).fill(0.5)
  const res = addon.search(vectors, 3, 2)
  assert.ok(res.labels.length <= 3)
})

test('KnnService.search retorna fraudCount para query de fraude', async () => {
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

  const { KnnService } = await import('./knn.ts')
  const svc = new KnnService(path)
  const fraudCount = svc.search(new Array(ndim).fill(0.95))
  assert.ok(fraudCount >= 3, `Esperava >=3 fraudes, got ${fraudCount}`)
  unlinkSync(path)
})
