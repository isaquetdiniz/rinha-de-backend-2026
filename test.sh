#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:9999}"
PASS=0
FAIL=0

# ── helpers ──────────────────────────────────────────────────────────────────

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
bold()  { printf '\033[1m%s\033[0m\n' "$*"; }

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    green "  PASS  $label"
    ((PASS++))
  else
    red   "  FAIL  $label (esperado=$expected, atual=$actual)"
    ((FAIL++))
  fi
}

post_fraud() {
  curl -s -X POST "$BASE_URL/fraud-score" \
    -H 'Content-Type: application/json' \
    -d "$1"
}

# ── /ready ────────────────────────────────────────────────────────────────────

bold "\n=== /ready ==="
READY=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/ready")
assert_eq "GET /ready → 200" "200" "$READY"

# ── casos básicos ─────────────────────────────────────────────────────────────

bold "\n=== Casos básicos ==="

# Transação normal — deve aprovar
NORMAL=$(post_fraud '{
  "id": "txn-normal",
  "transaction": { "amount": 50.00, "installments": 1, "requested_at": "2024-01-15T10:30:00Z" },
  "customer":    { "avg_amount": 55.00, "tx_count_24h": 2, "known_merchants": ["merchant-abc"] },
  "merchant":    { "id": "merchant-abc", "mcc": "5411", "avg_amount": 52.00 },
  "terminal":    { "is_online": true, "card_present": true, "km_from_home": 1.5 },
  "last_transaction": { "timestamp": "2024-01-15T08:00:00Z", "km_from_current": 1.0 }
}')
assert_eq "transação normal → approved=true" "true" "$(echo "$NORMAL" | grep -o '"approved":[^,}]*' | cut -d: -f2)"

# Transação suspeita — valor alto, MCC de risco, longe de casa
SUSPICIOUS=$(post_fraud '{
  "id": "txn-suspeita",
  "transaction": { "amount": 9500.00, "installments": 1, "requested_at": "2024-01-15T03:00:00Z" },
  "customer":    { "avg_amount": 50.00, "tx_count_24h": 18, "known_merchants": [] },
  "merchant":    { "id": "casino-xyz", "mcc": "7995", "avg_amount": 9000.00 },
  "terminal":    { "is_online": true, "card_present": false, "km_from_home": 950.0 },
  "last_transaction": { "timestamp": "2024-01-15T02:55:00Z", "km_from_current": 900.0 }
}')
assert_eq "transação suspeita → approved=false" "false" "$(echo "$SUSPICIOUS" | grep -o '"approved":[^,}]*' | cut -d: -f2)"

# MCC desconhecido — deve funcionar sem crash
UNKNOWN_MCC=$(post_fraud '{
  "id": "txn-mcc-desconhecido",
  "transaction": { "amount": 100.00, "installments": 1, "requested_at": "2024-01-15T12:00:00Z" },
  "customer":    { "avg_amount": 100.00, "tx_count_24h": 1, "known_merchants": ["m1"] },
  "merchant":    { "id": "m1", "mcc": "9999", "avg_amount": 100.00 },
  "terminal":    { "is_online": true, "card_present": true, "km_from_home": 0.5 },
  "last_transaction": null
}')
assert_eq "MCC desconhecido → tem approved" "true" "$(echo "$UNKNOWN_MCC" | grep -qo '"approved":' && echo true || echo false)"

# last_transaction null — não deve crashar
NULL_LAST=$(post_fraud '{
  "id": "txn-sem-ultima",
  "transaction": { "amount": 200.00, "installments": 2, "requested_at": "2024-01-15T14:00:00Z" },
  "customer":    { "avg_amount": 180.00, "tx_count_24h": 3, "known_merchants": ["m2"] },
  "merchant":    { "id": "m2", "mcc": "5812", "avg_amount": 190.00 },
  "terminal":    { "is_online": true, "card_present": true, "km_from_home": 2.0 },
  "last_transaction": null
}')
assert_eq "last_transaction null → tem approved" "true" "$(echo "$NULL_LAST" | grep -qo '"approved":' && echo true || echo false)"

# fraud_score entre 0 e 1
SCORE=$(echo "$NORMAL" | grep -o '"fraud_score":[^,}]*' | cut -d: -f2)
IN_RANGE=$(awk "BEGIN { print ($SCORE >= 0 && $SCORE <= 1) ? \"true\" : \"false\" }")
assert_eq "fraud_score ∈ [0,1]" "true" "$IN_RANGE"

# ── latência ──────────────────────────────────────────────────────────────────

bold "\n=== Latência (50 requisições) ==="

PAYLOAD='{
  "id": "txn-lat",
  "transaction": { "amount": 150.00, "installments": 1, "requested_at": "2024-01-15T10:00:00Z" },
  "customer":    { "avg_amount": 145.00, "tx_count_24h": 2, "known_merchants": ["m3"] },
  "merchant":    { "id": "m3", "mcc": "5311", "avg_amount": 148.00 },
  "terminal":    { "is_online": true, "card_present": true, "km_from_home": 3.0 },
  "last_transaction": { "timestamp": "2024-01-15T09:00:00Z", "km_from_current": 2.5 }
}'

TIMES=()
for i in $(seq 1 50); do
  MS=$(curl -s -o /dev/null -w "%{time_total}" -X POST "$BASE_URL/fraud-score" \
    -H 'Content-Type: application/json' -d "$PAYLOAD" \
    | awk '{ printf "%.0f", $1 * 1000 }')
  TIMES+=("$MS")
done

# calcula min, max, p50, p99
SORTED=($(printf '%s\n' "${TIMES[@]}" | sort -n))
N=${#SORTED[@]}
MIN=${SORTED[0]}
MAX=${SORTED[$((N-1))]}
P50=${SORTED[$((N*50/100))]}
P99=${SORTED[$((N*99/100))]}
SUM=0; for t in "${TIMES[@]}"; do ((SUM+=t)); done
AVG=$((SUM/N))

printf "  min=%dms  avg=%dms  p50=%dms  p99=%dms  max=%dms\n" \
  "$MIN" "$AVG" "$P50" "$P99" "$MAX"

if [ "$P99" -lt 100 ]; then
  green "  PASS  p99 < 100ms"
  ((PASS++))
else
  red   "  WARN  p99 = ${P99}ms (acima de 100ms)"
fi

# ── resultado ─────────────────────────────────────────────────────────────────

bold "\n=== Resultado ==="
echo "  passou: $PASS  falhou: $FAIL"
[ "$FAIL" -eq 0 ] && green "OK" || { red "FALHOU"; exit 1; }
