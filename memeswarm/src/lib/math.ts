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
