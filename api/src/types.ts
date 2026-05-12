export interface Transaction {
  amount: number
  installments: number
  requested_at: string
}

export interface Customer {
  avg_amount: number
  tx_count_24h: number
  known_merchants: string[]
}

export interface Merchant {
  id: string
  mcc: string
  avg_amount: number
}

export interface Terminal {
  is_online: boolean
  card_present: boolean
  km_from_home: number
}

export interface LastTransaction {
  timestamp: string
  km_from_current: number
}

export interface FraudRequest {
  id: string
  transaction: Transaction
  customer: Customer
  merchant: Merchant
  terminal: Terminal
  last_transaction: LastTransaction | null
}

export interface FraudResponse {
  approved: boolean
  fraud_score: number
}

export interface NormalizationConfig {
  max_amount: number
  max_installments: number
  amount_vs_avg_ratio: number
  max_minutes: number
  max_km: number
  max_tx_count_24h: number
  max_merchant_avg_amount: number
}

export interface Neighbor {
  label: 'fraud' | 'legit'
}
