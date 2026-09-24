// Minimal runnable check for resolveTradableAssets (src/lib/krakenData.ts)
// — no fixtures, no framework, no network. Run with:
//   npx tsx scripts/check-kraken-discovery.ts
//
// This is the logic that turns Kraken's raw AssetPairs response into the
// app's tradable roster: filtering to USD/USDT-quoted spot markets,
// deduping one pair per base asset (preferring direct USD over USDT),
// and resolving each base's display symbol. Untestable against the real
// API from this sandbox (network egress to api.kraken.com is blocked
// here), so this exercises it against a fabricated response shaped like
// Kraken's real one instead.

import { resolveTradableAssets } from '../src/lib/krakenData'
import type { KrakenAssetPairInfo } from '../src/lib/krakenData'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`)
}

const pairs: Record<string, KrakenAssetPairInfo> = {
  // Legacy-prefixed base, wsname present — BTC should resolve via wsname,
  // not the base-code regex fallback, and rename XBT -> BTC.
  XXBTZUSD: { altname: 'XBTUSD', wsname: 'XBT/USD', base: 'XXBT', quote: 'ZUSD' },
  XXBTZEUR: { altname: 'XBTEUR', wsname: 'XBT/EUR', base: 'XXBT', quote: 'ZEUR' }, // non-USD/USDT quote — must be excluded entirely
  // Same base (ETH) listed against both USD and USDT — USD must win.
  XETHZUSD: { altname: 'ETHUSD', wsname: 'ETH/USD', base: 'XETH', quote: 'ZUSD' },
  ETHUSDT: { altname: 'ETHUSDT', wsname: 'ETH/USDT', base: 'XETH', quote: 'USDT' },
  // Only USDT-quoted (no USD market at all) — must still be included via USDT.
  SOLUSDT: { altname: 'SOLUSDT', wsname: 'SOL/USDT', base: 'SOL', quote: 'USDT' },
  // Modern base code with no wsname — falls back to the base-code regex.
  // PEPE doesn't start with X/Z, so the regex fallback must leave it
  // untouched (it only strips a LEADING X/Z, and only above 3-4 remaining
  // chars) — the case the regex fallback can't fully disambiguate (a
  // genuinely X/Z-first modern ticker with no wsname) doesn't occur in
  // Kraken's real API, which always provides wsname for tradeable pairs.
  PEPEUSD: { altname: 'PEPEUSD', base: 'PEPE', quote: 'ZUSD' },
  // A pair quoted in something other than USD/USDT entirely (e.g. a
  // BTC-quoted pair) must be excluded, not misread as a USD market.
  ETHXBT: { altname: 'ETHXBT', wsname: 'ETH/XBT', base: 'XETH', quote: 'XXBT' },
}

const resolved = resolveTradableAssets(pairs)
const byLabel = Object.fromEntries(resolved.map((a) => [a.label, a]))

assert(resolved.length === 4, `expected exactly 4 resolved assets (BTC, ETH, SOL, PEPE — deduped, EUR/XBT-quoted pairs excluded), got ${resolved.length}: ${JSON.stringify(resolved)}`)
assert('BTC' in byLabel, 'XBT must rename to BTC')
assert(byLabel.BTC.pairKey === 'XXBTZUSD', 'BTC must resolve to its USD pair, not the EUR one')
assert('ETH' in byLabel, 'ETH must resolve despite listing both USD and USDT markets')
assert(byLabel.ETH.pairKey === 'XETHZUSD', 'ETH must prefer the direct USD market over USDT')
assert('SOL' in byLabel, 'a USDT-only base (no USD market) must still resolve')
assert(byLabel.SOL.pairKey === 'SOLUSDT', 'SOL must resolve via its only (USDT) market')
assert('PEPE' in byLabel, 'PEPE (no wsname, no leading X/Z) must resolve unchanged via the base-code fallback')
assert(!('XBT' in byLabel), 'the EUR-quoted duplicate must not leak a second, wrongly-labeled entry')

// Every resolved pairKey must be a real key from the input, and every
// resolved label must be unique (the whole point of the dedup pass).
for (const a of resolved) assert(a.pairKey in pairs, `pairKey "${a.pairKey}" must come from the input`)
const labels = resolved.map((a) => a.label)
assert(new Set(labels).size === labels.length, 'resolved labels must be unique — one pair per base asset')

console.log('OK — resolveTradableAssets:', JSON.stringify(resolved))
