// Minimal runnable check for rsi()/macdHistogram() (src/lib/math.ts) — no
// fixtures, no framework. Run with: npx tsx scripts/check-indicators.ts
//
// Verifies both against known reference behavior on synthetic series a
// human can reason about directly (pure uptrend, pure downtrend, flat,
// insufficient history) rather than against real market data.

import { macdHistogram, rsi } from '../src/lib/math'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`)
}

function approx(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol
}

// --- rsi() ---

// A monotonic uptrend has zero losses in the trailing window -> RSI = 100.
const uptrend = Array.from({ length: 30 }, (_, i) => 100 + i)
assert(rsi(uptrend, 14) === 100, `pure uptrend must give RSI 100, got ${rsi(uptrend, 14)}`)

// A monotonic downtrend has zero gains -> RSI = 0.
const downtrend = Array.from({ length: 30 }, (_, i) => 100 - i)
assert(rsi(downtrend, 14) === 0, `pure downtrend must give RSI 0, got ${rsi(downtrend, 14)}`)

// A flat series has zero gains AND zero losses -> RSI defined as neutral 50.
const flat = Array.from({ length: 30 }, () => 100)
assert(rsi(flat, 14) === 50, `flat series must give RSI 50, got ${rsi(flat, 14)}`)

// Equal-sized up/down alternation -> average gain roughly equals average
// loss -> RSI near 50.
const oscillating = Array.from({ length: 30 }, (_, i) => 100 + (i % 2 === 0 ? 1 : -1))
assert(approx(rsi(oscillating, 14), 50, 15), `oscillating series should be roughly neutral, got ${rsi(oscillating, 14)}`)

// Not enough history -> defined fallback of 50 (neutral, gates nothing),
// never a crash or NaN.
assert(rsi([100, 101, 102], 14) === 50, 'too little history must fall back to neutral 50, not NaN/crash')

// --- macdHistogram() ---

// A sustained uptrend means the fast EMA pulls further ahead of the slow
// EMA over time -> MACD line rising -> line > its own (lagging) signal
// line -> positive histogram.
const macdUptrend = Array.from({ length: 60 }, (_, i) => 100 + i * 0.8)
assert(macdHistogram(macdUptrend, 12, 26, 9) > 0, 'sustained uptrend must give a positive MACD histogram')

// Mirror case for a sustained downtrend.
const macdDowntrend = Array.from({ length: 60 }, (_, i) => 100 - i * 0.8)
assert(macdHistogram(macdDowntrend, 12, 26, 9) < 0, 'sustained downtrend must give a negative MACD histogram')

// A flat series has no momentum in either direction -> histogram ~0.
const macdFlat = Array.from({ length: 60 }, () => 100)
assert(approx(macdHistogram(macdFlat, 12, 26, 9), 0, 1e-9), `flat series must give ~0 histogram, got ${macdHistogram(macdFlat, 12, 26, 9)}`)

// Not enough history -> defined fallback of 0, never a crash or NaN.
assert(macdHistogram([100, 101, 102], 12, 26, 9) === 0, 'too little history must fall back to 0, not NaN/crash')

console.log('OK — rsi()/macdHistogram(): all reference cases passed')
