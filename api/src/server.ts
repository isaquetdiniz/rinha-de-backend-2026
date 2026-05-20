import { chmodSync } from 'node:fs'
import { resolve } from 'node:path'
import { App } from 'uWebSockets.js'
import { KnnService } from './knn.ts'
import { toVector } from './normalize.ts'
import { phases, statsJSON } from './stats.ts'
import type { FraudRequest } from './types.ts'

const DECODER = new TextDecoder()

const DATA_DIR    = process.env['DATA_DIR']    ?? '/data'
const SOCKET_PATH = process.env['SOCKET_PATH'] as string
const K           = 5
const THRESHOLD   = 0.6

// Pré-computa as 6 respostas possíveis (K=5 → fraudCount ∈ {0..5}) — zero JSON.stringify por request
const RESPONSES = Array.from({ length: K + 1 }, (_, fraudCount) => {
  const fraud_score = fraudCount / K
  return JSON.stringify({ approved: fraud_score < THRESHOLD, fraud_score })
})

interface Searcher { search(vector: number[]): number }

const searcher: Searcher = new KnnService(resolve(DATA_DIR, 'knn.index'))

// Aquece L2/L3 cache e branch predictor — elimina cold-start no p99
const _warmupVec = new Array(14).fill(0.5)
for (let i = 0; i < 500; i++) searcher.search(_warmupVec)

const app = App()

app.get('/ready', (res) => {
  searcher.search(new Array(14).fill(0))
  res.cork(() => {
    res.writeStatus('200 OK')
    res.end('ok')
  })
})

app.post('/fraud-score', (res) => {
  let aborted = false
  res.onAborted(() => { aborted = true })

  // null until a multi-chunk body arrives (rare — avoids array alloc per request)
  let chunks: Buffer[] | null = null

  res.onData((chunk, isLast) => {
    if (!isLast) {
      if (!chunks) chunks = []
      chunks.push(Buffer.from(chunk))
      return
    }
    if (aborted) return

    const t0 = performance.now()
    let body: FraudRequest
    try {
      const tp = performance.now()
      // Fast path (>99% of requests): single chunk — decode ArrayBuffer directly, zero extra copies
      const str = chunks
        ? Buffer.concat([...chunks, Buffer.from(chunk)]).toString()
        : DECODER.decode(chunk)
      body = JSON.parse(str) as FraudRequest
      phases.jsonParse.record(performance.now() - tp)
    } catch {
      res.cork(() => { res.writeStatus('400 Bad Request'); res.end() })
      return
    }

    try {
      const t1 = performance.now()
      const vector = toVector(body)
      phases.toVector.record(performance.now() - t1)

      const fraudCount = searcher.search(vector)
      phases.total.record(performance.now() - t0)

      res.cork(() => {
        res.writeStatus('200 OK')
        res.writeHeader('Content-Type', 'application/json')
        res.end(RESPONSES[fraudCount])
      })
    } catch {
      res.cork(() => { res.writeStatus('500 Internal Server Error'); res.end() })
    }
  })
})

app.get('/stats', (res) => {
  res.cork(() => {
    res.writeStatus('200 OK')
    res.writeHeader('Content-Type', 'application/json')
    res.end(statsJSON())
  })
})

app.any('/*', (res) => {
  res.cork(() => { res.writeStatus('404 Not Found'); res.end() })
})

app.listen_unix((token) => {
  if (!token) throw new Error(`Failed to listen on socket ${SOCKET_PATH}`)
  chmodSync(SOCKET_PATH, 0o777)
}, SOCKET_PATH)
