// Small, framework-agnostic math helpers shared by the live engine
// (simulation.ts) and the headless statistical backtester (backtest.ts) —
// kept in one place so both always agree on how randomness/statistics work.

export function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v))
}

export function randRange(min: number, max: number) {
  return min + Math.random() * (max - min)
}

export function randNormal() {
  // Box-Muller
  let u = 0
  let v = 0
  while (u === 0) u = Math.random()
  while (v === 0) v = Math.random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

export function choice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

export function mean(arr: number[]) {
  if (!arr.length) return 0
  return arr.reduce((a, b) => a + b, 0) / arr.length
}

export function stdDev(arr: number[]) {
  if (arr.length < 2) return 0
  const m = mean(arr)
  return Math.sqrt(mean(arr.map((v) => (v - m) ** 2)))
}

export function diffs(arr: number[]): number[] {
  const out: number[] = []
  for (let i = 1; i < arr.length; i++) out.push(arr[i] - arr[i - 1])
  return out
}

export function uid() {
  return Math.random().toString(36).slice(2, 10)
}

// Exponential moving average, seeded at the first value (standard
// warm-start) rather than an SMA seed — fine for the short windows this is
// used with (see macdHistogram below).
function ema(values: number[], period: number): number {
  if (values.length === 0) return 0
  const k = 2 / (period + 1)
  let e = values[0]
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k)
  return e
}

// ponytail: SMA-based RSI (average gain/loss over a plain trailing window),
// not Wilder's exponentially-smoothed original — recomputed fresh from
// whatever window the caller passes, the same "no persistent smoothing
// state" approach vol/trend already use elsewhere in this codebase. Good
// enough for a threshold gate; upgrade path is a persisted EMA-smoothed
// average per tracked asset if finer precision is ever needed.
export function rsi(closes: number[], period: number): number {
  if (closes.length < period + 1) return 50 // not enough history — neutral, gates nothing
  const changes = diffs(closes).slice(-period)
  const avgGain = mean(changes.map((c) => Math.max(c, 0)))
  const avgLoss = mean(changes.map((c) => Math.max(-c, 0)))
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100
  return 100 - 100 / (1 + avgGain / avgLoss)
}

// MACD histogram (MACD line minus its own signal line). IMPORTANT: pass a
// bounded recent window, not an ever-growing full price history — the
// signal line needs a short series of MACD-line values, built by an O(n^2)
// scan over whatever `closes` it's given, so an unbounded caller would make
// this expensive on a long-running backtest. A window of roughly
// slowPeriod+signalPeriod+10 is enough for a stable reading.
export function macdHistogram(closes: number[], fastPeriod: number, slowPeriod: number, signalPeriod: number): number {
  const minLen = slowPeriod + signalPeriod
  if (closes.length < minLen) return 0
  const macdSeries: number[] = []
  for (let i = slowPeriod; i <= closes.length; i++) {
    const window = closes.slice(0, i)
    macdSeries.push(ema(window, fastPeriod) - ema(window, slowPeriod))
  }
  const macdLine = macdSeries[macdSeries.length - 1]
  const signalLine = ema(macdSeries, signalPeriod)
  return macdLine - signalLine
}
