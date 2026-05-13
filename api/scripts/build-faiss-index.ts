import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import type { Index as IndexType } from 'faiss-node'
import { parseReferences } from './parse-refs.ts'

const require = createRequire(import.meta.url)
const { Index } = require('faiss-node') as typeof import('faiss-node')

const __dirname = dirname(fileURLToPath(import.meta.url))
const REFS_PATH = resolve(__dirname, '..', 'references.json.gz')
const OUTPUT_DIR = process.env['OUTPUT_DIR'] ?? '/data'
const DIMS = 14

mkdirSync(OUTPUT_DIR, { recursive: true })

console.log('Carregando vetores...')
const flatVectors: number[] = []
const labelBytes: number[] = []

let count = 0
for await (const record of parseReferences(REFS_PATH)) {
  for (const v of record.vector) flatVectors.push(v)
  labelBytes.push(record.label === 'fraud' ? 1 : 0)
  count++
  if (count % 500_000 === 0) console.log(`  ${count} vetores lidos...`)
}
console.log(`Total: ${count} vetores`)

console.log('Treinando índice IVF1024,SQ8...')
const index: IndexType = Index.fromFactory(DIMS, 'IVF1024,SQ8')
index.train(flatVectors)

console.log('Adicionando vetores...')
index.add(flatVectors)

const indexPath = resolve(OUTPUT_DIR, 'txns.index')
const labelsPath = resolve(OUTPUT_DIR, 'txns.labels')

index.write(indexPath)
writeFileSync(labelsPath, Buffer.from(new Uint8Array(labelBytes)))

console.log(`Índice salvo: ${indexPath} (${index.ntotal()} vetores)`)
console.log(`Labels salvas: ${labelsPath}`)
