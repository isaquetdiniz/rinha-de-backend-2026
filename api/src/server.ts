import { resolve } from 'node:path'
import Fastify from 'fastify'
import { FaissService } from './faiss.ts'
import { toVector } from './normalize.ts'
import type { FraudRequest, FraudResponse, NormalizationConfig } from './types.ts'

const DATA_DIR = process.env['DATA_DIR'] ?? '/data'

const norm: NormalizationConfig = {
  max_amount: 10000,
  max_installments: 12,
  amount_vs_avg_ratio: 10,
  max_minutes: 1440,
  max_km: 1000,
  max_tx_count_24h: 20,
  max_merchant_avg_amount: 10000,
}

const mccRisk: Map<string, number> = new Map([
  ['5411', 0.15],
  ['5812', 0.30],
  ['5912', 0.20],
  ['5944', 0.45],
  ['7801', 0.80],
  ['7802', 0.75],
  ['7995', 0.85],
  ['4511', 0.35],
  ['5311', 0.25],
  ['5999', 0.50],
])

const faiss = new FaissService(
  resolve(DATA_DIR, 'txns.index'),
  resolve(DATA_DIR, 'txns.labels'),
)

const fastify = Fastify({ logger: false })

fastify.get('/ready', async () => {
  faiss.search(new Array(14).fill(0))
  return 'ok'
})

fastify.post<{ Body: FraudRequest; Reply: FraudResponse }>(
  '/fraud-score',
  async (req) => {
    const vector = toVector(req.body, mccRisk, norm)
    const fraudCount = faiss.search(vector)
    const fraud_score = fraudCount / 5
    return { approved: fraud_score < 0.6, fraud_score }
  },
)

await fastify.listen({ port: 3000, host: '0.0.0.0' })
