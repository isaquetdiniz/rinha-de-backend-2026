import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { toVector } from './normalize.ts'
import type { FraudRequest, NormalizationConfig } from './types.ts'

const norm: NormalizationConfig = {
  max_amount: 10000,
  max_installments: 12,
  amount_vs_avg_ratio: 10,
  max_minutes: 1440,
  max_km: 1000,
  max_tx_count_24h: 20,
  max_merchant_avg_amount: 10000,
}

function near(a: number, b: number, tol = 0.0001): boolean {
  return Math.abs(a - b) < tol
}

describe('toVector', () => {
  it('transação legítima sem last_transaction', () => {
    const payload: FraudRequest = {
      id: 'tx-legit',
      transaction: { amount: 41, installments: 2, requested_at: '2024-01-16T18:00:00Z' },
      customer: { avg_amount: 82, tx_count_24h: 3, known_merchants: ['MERC-001'] },
      merchant: { id: 'MERC-001', mcc: '5912', avg_amount: 60 },
      terminal: { is_online: false, card_present: true, km_from_home: 29.2 },
      last_transaction: null,
    }
    const mccRisk = new Map([['5912', 0.15]])
    const vec = toVector(payload, mccRisk, norm)

    assert.equal(vec.length, 14)
    assert.ok(near(vec[0]!, 0.0041),   `dim[0] esperado 0.0041, recebido ${vec[0]}`)
    assert.ok(near(vec[1]!, 0.1667),   `dim[1] esperado 0.1667, recebido ${vec[1]}`)
    assert.ok(near(vec[2]!, 0.05),     `dim[2] esperado 0.05, recebido ${vec[2]}`)
    assert.ok(near(vec[3]!, 0.7826),   `dim[3] esperado 0.7826, recebido ${vec[3]}`)
    assert.ok(near(vec[4]!, 0.3333),   `dim[4] esperado 0.3333, recebido ${vec[4]}`)
    assert.equal(vec[5], -1)
    assert.equal(vec[6], -1)
    assert.ok(near(vec[7]!, 0.0292),   `dim[7] esperado 0.0292, recebido ${vec[7]}`)
    assert.ok(near(vec[8]!, 0.15),     `dim[8] esperado 0.15, recebido ${vec[8]}`)
    assert.equal(vec[9],  0)
    assert.equal(vec[10], 1)
    assert.equal(vec[11], 0)
    assert.ok(near(vec[12]!, 0.15),    `dim[12] esperado 0.15, recebido ${vec[12]}`)
    assert.ok(near(vec[13]!, 0.006),   `dim[13] esperado 0.006, recebido ${vec[13]}`)
  })

  it('transação fraudulenta sem last_transaction', () => {
    const payload: FraudRequest = {
      id: 'tx-fraud',
      transaction: { amount: 9506, installments: 10, requested_at: '2024-01-19T05:00:00Z' },
      customer: { avg_amount: 500, tx_count_24h: 20, known_merchants: [] },
      merchant: { id: 'MERC-999', mcc: '5815', avg_amount: 55 },
      terminal: { is_online: false, card_present: true, km_from_home: 952.3 },
      last_transaction: null,
    }
    const mccRisk = new Map([['5815', 0.75]])
    const vec = toVector(payload, mccRisk, norm)

    assert.ok(near(vec[0]!, 0.9506))
    assert.ok(near(vec[1]!, 0.8333))
    assert.equal(vec[2], 1.0)           // clamped: (9506/500)/10 = 1.9 → 1.0
    assert.ok(near(vec[3]!, 0.2174))
    assert.ok(near(vec[4]!, 0.8333))
    assert.equal(vec[5],  -1)
    assert.equal(vec[6],  -1)
    assert.ok(near(vec[7]!, 0.9523))
    assert.equal(vec[8],  1.0)
    assert.equal(vec[9],  0)
    assert.equal(vec[10], 1)
    assert.equal(vec[11], 1)            // merchant desconhecido
    assert.ok(near(vec[12]!, 0.75))
    assert.ok(near(vec[13]!, 0.0055))
  })

  it('com last_transaction presente', () => {
    const payload: FraudRequest = {
      id: 'tx-with-last',
      transaction: { amount: 100, installments: 1, requested_at: '2024-01-16T18:00:00Z' },
      customer: { avg_amount: 200, tx_count_24h: 1, known_merchants: [] },
      merchant: { id: 'MERC-X', mcc: '9999', avg_amount: 100 },
      terminal: { is_online: true, card_present: false, km_from_home: 0 },
      last_transaction: { timestamp: '2024-01-16T10:00:00Z', km_from_current: 50 },
    }
    const mccRisk = new Map<string, number>()
    const vec = toVector(payload, mccRisk, norm)

    // dim[5]: 480 min / 1440 = 0.3333
    assert.ok(near(vec[5]!, 0.3333), `dim[5] esperado 0.3333, recebido ${vec[5]}`)
    // dim[6]: 50 km / 1000 = 0.05
    assert.ok(near(vec[6]!, 0.05),   `dim[6] esperado 0.05, recebido ${vec[6]}`)
    // mcc não encontrado → default 0.5
    assert.equal(vec[12], 0.5)
  })

  it('avg_amount zero → dim[2] = 1.0', () => {
    const payload: FraudRequest = {
      id: 'tx-zero-avg',
      transaction: { amount: 100, installments: 1, requested_at: '2024-01-16T12:00:00Z' },
      customer: { avg_amount: 0, tx_count_24h: 1, known_merchants: [] },
      merchant: { id: 'X', mcc: '0000', avg_amount: 100 },
      terminal: { is_online: false, card_present: true, km_from_home: 0 },
      last_transaction: null,
    }
    const vec = toVector(payload, new Map(), norm)
    assert.equal(vec[2], 1.0)
  })
})
