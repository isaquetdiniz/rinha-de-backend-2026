import { chmodSync } from 'node:fs'
import { resolve } from 'node:path'
import { App } from 'uWebSockets.js'
import { FaissService } from './faiss.ts'
import { toVector } from './normalize.ts'
import type { FraudRequest } from './types.ts'

const DATA_DIR = process.env['DATA_DIR'] ?? '/data'
const SOCKET_PATH = process.env['SOCKET_PATH'] as string

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
      const vector = toVector(body)
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

app.listen_unix((token) => {
  if (!token) throw new Error(`Failed to listen on socket ${SOCKET_PATH}`)
    chmodSync(SOCKET_PATH, 0o777)
}, SOCKET_PATH)

