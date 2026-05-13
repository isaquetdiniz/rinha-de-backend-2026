import { resolve } from 'node:path'
import { App } from 'uWebSockets.js'
import { FaissService } from './faiss.ts'
import { toVector } from './normalize.ts'
import type { FraudRequest, NormalizationConfig } from './types.ts'

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

const app = App()

app.get('/ready', (res) => {
  faiss.search(new Array(14).fill(0))
  res.cork(() => {
    res.writeStatus('200 OK')
    res.end('ok')
  })
})

app.post('/fraud-score', (res) => {
  let aborted = false
  res.onAborted(() => { aborted = true })

  const chunks: Buffer[] = []

  res.onData((chunk, isLast) => {
    chunks.push(Buffer.from(chunk))
    if (!isLast) return

    if (aborted) return

    let body: FraudRequest
    try {
      body = JSON.parse(Buffer.concat(chunks).toString()) as FraudRequest
    } catch {
      res.cork(() => {
        res.writeStatus('400 Bad Request')
        res.end()
      })
      return
    }

    try {
      const vector = toVector(body, mccRisk, norm)
      const fraudCount = faiss.search(vector)
      const fraud_score = fraudCount / 5
      const response = JSON.stringify({ approved: fraud_score < 0.6, fraud_score })
      res.cork(() => {
        res.writeStatus('200 OK')
        res.writeHeader('Content-Type', 'application/json')
        res.end(response)
      })
    } catch {
      res.cork(() => {
        res.writeStatus('500 Internal Server Error')
        res.end()
      })
    }
  })
})

app.any('/*', (res) => {
  res.cork(() => {
    res.writeStatus('404 Not Found')
    res.end()
  })
})

app.listen(3000, (token) => {
  if (!token) throw new Error('Failed to listen on port 3000')
})
