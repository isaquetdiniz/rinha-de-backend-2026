import { QdrantClient } from '@qdrant/js-client-rest'
import { parseReferences } from './parse-refs.ts'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REFS_PATH = resolve(__dirname, 'references.json.gz')
const COLLECTION = 'txns'
const BATCH_SIZE = 2000
const QDRANT_URL = process.env['QDRANT_URL'] ?? 'http://localhost:6333'

const client = new QdrantClient({ url: QDRANT_URL })

async function waitForQdrant(maxAttempts = 30): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await client.api().healthz({})
      console.log('Qdrant pronto')
      return
    } catch {
      console.log(`Aguardando Qdrant... (${i + 1}/${maxAttempts})`)
      await new Promise(r => setTimeout(r, 2000))
    }
  }
  throw new Error('Qdrant não ficou disponível')
}

async function createCollection(): Promise<void> {
  const result = await client.collectionExists(COLLECTION)
  if (result.exists) {
    console.log('Coleção já existe, deletando...')
    await client.deleteCollection(COLLECTION)
  }
  await client.createCollection(COLLECTION, {
    vectors: { size: 14, distance: 'Euclid', on_disk: true },
    quantization_config: {
      scalar: { type: 'int8', quantile: 0.99, always_ram: true },
    },
    hnsw_config: { m: 4, ef_construct: 200, on_disk: false },
  })
  console.log('Coleção criada')
}

async function insertVectors(): Promise<void> {
  let batch: Array<{ id: number; vector: number[]; payload: { label: string } }> = []
  let id = 0
  let total = 0

  for await (const record of parseReferences(REFS_PATH)) {
    batch.push({ id: id++, vector: record.vector, payload: { label: record.label } })

    if (batch.length === BATCH_SIZE) {
      await client.upsert(COLLECTION, { wait: false, points: batch })
      total += batch.length
      batch = []
      if (total % 100_000 === 0) console.log(`Inseridos: ${total}`)
    }
  }

  if (batch.length > 0) {
    await client.upsert(COLLECTION, { wait: true, points: batch })
    total += batch.length
  }

  console.log(`Total inserido: ${total}`)
}

async function waitForIndex(): Promise<void> {
  console.log('Aguardando construção do índice...')
  await client.updateCollection(COLLECTION, {
    optimizers_config: { indexing_threshold: 0 },
  })

  for (let i = 0; i < 120; i++) {
    const info = await client.getCollection(COLLECTION)
    const status = info.status
    console.log(`Status: ${status} (${i + 1}/120)`)
    if (status === 'green') {
      console.log('Índice construído!')
      return
    }
    await new Promise(r => setTimeout(r, 5000))
  }
  throw new Error('Índice não foi construído em 10 minutos')
}

await waitForQdrant()
await createCollection()
await insertVectors()
await waitForIndex()
console.log('Build concluído com sucesso')
