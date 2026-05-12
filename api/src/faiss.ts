import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { Index as IndexType } from 'faiss-node'

const require = createRequire(import.meta.url)
const { Index } = require('faiss-node') as typeof import('faiss-node')

export class FaissService {
  private index: IndexType
  private labels: Buffer

  constructor(indexPath: string, labelsPath: string) {
    this.index = Index.read(indexPath)
    this.labels = readFileSync(labelsPath)
  }

  search(vector: number[]): number {
    const { labels } = this.index.search(vector, 5)
    let fraudCount = 0
    for (const i of labels) {
      if (i !== -1 && this.labels[i] === 1) fraudCount++
    }
    return fraudCount
  }
}
