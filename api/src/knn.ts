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

const addon        = require(resolve(__dirname, '../knn-addon/index.js')) as KnnAddon
const K            = parseInt(process.env['KNN_K']            ?? '5',  10)
const NPROBE       = parseInt(process.env['KNN_NPROBE']       ?? '64', 10)
const NPROBE_FAST  = parseInt(process.env['KNN_NPROBE_FAST']  ?? '2',  10)

function countFraud(labels: Int32Array): number {
  let n = 0
  for (let i = 0; i < labels.length; i++) if (labels[i] === 1) n++
  return n
}

export class KnnService {
  constructor(indexPath: string) {
    addon.loadIndex(indexPath)
  }

  search(vector: number[]): number {
    const v = new Float32Array(vector)
    const { labels } = addon.search(v, K, NPROBE_FAST)
    const fraudCount = countFraud(labels)
    // Unânime → confiança alta, retorna sem expansão
    if (fraudCount === 0 || fraudCount === K) return fraudCount
    // Ambíguo → expande para nProbe completo
    return countFraud(addon.search(v, K, NPROBE).labels)
  }

  getStats() {
    return addon.getStats()
  }
}
