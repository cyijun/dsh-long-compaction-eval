/** Deterministic paired summaries and cluster-bootstrap confidence intervals. */

export interface ConfidenceInterval {
  estimate: number
  low: number
  high: number
  n: number
}

/** Mean with a task-level non-parametric bootstrap interval. */
export function bootstrapMean(values: readonly number[], iterations = 10_000, seed = 20260823): ConfidenceInterval {
  if (values.length === 0) return { estimate: Number.NaN, low: Number.NaN, high: Number.NaN, n: 0 }
  const random = xorshift(seed)
  const samples = Array.from({ length: iterations }, () => {
    let total = 0
    for (let index = 0; index < values.length; index += 1) {
      total += values[Math.floor(random() * values.length)] ?? 0
    }
    return total / values.length
  }).sort((left, right) => left - right)
  return {
    estimate: mean(values),
    low: percentile(samples, 0.025),
    high: percentile(samples, 0.975),
    n: values.length,
  }
}

/** Arithmetic mean; empty input returns NaN explicitly. */
export function mean(values: readonly number[]): number {
  return values.length === 0 ? Number.NaN : values.reduce((total, value) => total + value, 0) / values.length
}

/** Median over a detached sorted copy; empty input returns NaN. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[middle] ?? Number.NaN
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) return Number.NaN
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(quantile * sorted.length)))
  return sorted[index] ?? Number.NaN
}

function xorshift(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
}
