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
