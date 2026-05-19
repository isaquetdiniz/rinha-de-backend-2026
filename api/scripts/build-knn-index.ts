import { mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { parseReferences } from './parse-refs.ts'

const require   = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))

const addon = require(resolve(__dirname, '../knn-addon/index.js')) as {
  buildIndex: (vectors: Float32Array, labels: Int32Array, nlist: number, iterations: number) => void
  saveIndex:  (path: string) => void
  getStats:   () => { nlist: number; ntotal: number }
}

const REFS_PATH  = resolve(__dirname, '..', 'references.json.gz')
const OUTPUT_DIR = process.env['OUTPUT_DIR']       ?? '/data'
const NLIST      = parseInt(process.env['KNN_NLIST']      ?? '1024', 10)
const ITERATIONS = parseInt(process.env['KNN_ITERATIONS'] ?? '20',   10)

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
