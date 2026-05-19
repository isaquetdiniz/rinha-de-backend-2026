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
