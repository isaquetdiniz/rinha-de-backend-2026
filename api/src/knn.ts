import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require   = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))

interface KnnAddon {
  loadIndex(path: string): void
  searchFraud(
    v0: number, v1: number, v2: number, v3: number,
    v4: number, v5: number, v6: number, v7: number,
    v8: number, v9: number, v10: number, v11: number,
    v12: number, v13: number,
    k: number, nProbeFast: number, nProbeFull: number, thresholdCount: number,
  ): number
  getStats(): { nlist: number; ntotal: number }
}

const addon           = require(resolve(__dirname, '../knn-addon/index.js')) as KnnAddon
const K               = 5
const NPROBE_FULL     = parseInt(process.env['KNN_NPROBE']      ?? '64', 10)
const NPROBE_FAST     = parseInt(process.env['KNN_NPROBE_FAST'] ?? '2',  10)
const THRESHOLD_COUNT = Math.ceil(0.6 * K)

export class KnnService {
  constructor(indexPath: string) {
    addon.loadIndex(indexPath)
  }

  search(v: number[]): number {
    return addon.searchFraud(
      v[0], v[1], v[2],  v[3],  v[4],  v[5],  v[6],  v[7],
      v[8], v[9], v[10], v[11], v[12], v[13],
      K, NPROBE_FAST, NPROBE_FULL, THRESHOLD_COUNT,
    )
  }

  getStats() {
    return addon.getStats()
  }
}
