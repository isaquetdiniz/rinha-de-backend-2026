import type { FraudRequest, NormalizationConfig } from './types.ts'

const clamp = (v: number): number => Math.min(1, Math.max(0, v))

function minutesDiff(fromTs: string, toTs: string): number {
  return (new Date(toTs).getTime() - new Date(fromTs).getTime()) / 60_000
}

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

export function toVector(
  p: FraudRequest,
): number[] {
  const ts = new Date(p.transaction.requested_at)
  const lst = p.last_transaction

  return [
    clamp(p.transaction.amount / norm.max_amount),
    clamp(p.transaction.installments / norm.max_installments),
    p.customer.avg_amount > 0
      ? clamp((p.transaction.amount / p.customer.avg_amount) / norm.amount_vs_avg_ratio)
      : 1.0,
    ts.getUTCHours() / 23,
    (ts.getUTCDay() + 6) % 7 / 6,
    lst ? clamp(minutesDiff(lst.timestamp, p.transaction.requested_at) / norm.max_minutes) : -1,
    lst ? clamp(lst.km_from_current / norm.max_km) : -1,
    clamp(p.terminal.km_from_home / norm.max_km),
    clamp(p.customer.tx_count_24h / norm.max_tx_count_24h),
    p.terminal.is_online ? 1 : 0,
    p.terminal.card_present ? 1 : 0,
    p.customer.known_merchants.includes(p.merchant.id) ? 0 : 1,
    mccRisk.get(p.merchant.mcc) ?? 0.5,
    clamp(p.merchant.avg_amount / norm.max_merchant_avg_amount),
  ]
}
