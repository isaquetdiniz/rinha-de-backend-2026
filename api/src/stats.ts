const WINDOW = 2000

class PhaseStats {
  private buf = new Float64Array(WINDOW)
  private pos = 0
  count = 0

  record(ms: number): void {
    this.buf[this.pos] = ms
    this.pos = (this.pos + 1) % WINDOW
    this.count++
  }

  percentile(p: number): number {
    const n = Math.min(this.count, WINDOW)
    if (n === 0) return 0
    const view = this.buf.slice(0, n)
    view.sort()
    return view[Math.max(0, Math.ceil((p / 100) * n) - 1)]!
  }

  toJSON() {
    return { count: this.count, p50: +this.percentile(50).toFixed(3), p95: +this.percentile(95).toFixed(3), p99: +this.percentile(99).toFixed(3) }
  }
}

export const phases = {
  total:    new PhaseStats(),
  jsonParse: new PhaseStats(),
  toVector:  new PhaseStats(),
  knnFast:   new PhaseStats(),
  knnFull:   new PhaseStats(),
}

export let expansions = 0
export function incExpansions(): void { expansions++ }

export function resetStats(): void {
  for (const p of Object.values(phases)) { (p as PhaseStats).count = 0 }
  expansions = 0
}

export function statsJSON(): string {
  const total = phases.total.count
  return JSON.stringify({
    requests: total,
    expansion_rate: total > 0 ? +(expansions / total * 100).toFixed(2) : 0,
    phases: {
      total:     phases.total.toJSON(),
      json_parse: phases.jsonParse.toJSON(),
      to_vector:  phases.toVector.toJSON(),
      knn_fast:   phases.knnFast.toJSON(),
      knn_full:   phases.knnFull.toJSON(),
    },
  })
}
