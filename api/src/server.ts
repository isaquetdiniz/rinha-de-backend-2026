import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Fastify from 'fastify'
import { QdrantService } from './qdrant.ts'
import { toVector } from './normalize.ts'
import type { FraudRequest, FraudResponse, NormalizationConfig } from './types.ts'

const DATA_DIR = process.env['DATA_DIR'] ?? '/data'

const norm: NormalizationConfig = JSON.parse(
  readFileSync(resolve(DATA_DIR, 'normalization.json'), 'utf8'),
)

const mccRisk: Map<string, number> = new Map(
  Object.entries(
    JSON.parse(readFileSync(resolve(DATA_DIR, 'mcc_risk.json'), 'utf8')),
  ),
)

const qdrant = new QdrantService(
  process.env['QDRANT_URL'] ?? 'http://qdrant:6333',
)

const fastify = Fastify({ logger: false })

fastify.get('/ready', async (_, reply) => {
  const ready = await qdrant.isReady()
  if (!ready) return reply.code(503).send('not ready')
  return 'ok'
})

fastify.post<{ Body: FraudRequest; Reply: FraudResponse }>(
  '/fraud-score',
  async (req) => {
    const vector = toVector(req.body, mccRisk, norm)
    const neighbors = await qdrant.findNeighbors(vector)
    const fraudCount = neighbors.filter(n => n.label === 'fraud').length
    const fraud_score = fraudCount / 5
    return { approved: fraud_score < 0.6, fraud_score }
  },
)

await fastify.listen({ port: 3000, host: '0.0.0.0' })
