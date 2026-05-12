import type { FraudRequest, NormalizationConfig } from './types.ts'

const clamp = (v: number): number => Math.min(1, Math.max(0, v))

function minutesDiff(fromTs: string, toTs: string): number {
  return (new Date(toTs).getTime() - new Date(fromTs).getTime()) / 60_000
}

export function toVector(
  p: FraudRequest,
  mccRisk: Map<string, number>,
  norm: NormalizationConfig,
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
    ts.getUTCDay() / 6,
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
