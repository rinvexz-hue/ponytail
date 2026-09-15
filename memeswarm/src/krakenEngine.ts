// Live paper-trading engine on real Kraken prices — PAPER MODE ONLY.
//
// This never places a real order: it reads public ticker data (see
// lib/krakenData.ts, which itself never touches an account/order endpoint)
// and runs the SAME validated real-asset entry/exit/risk rules as
// backtest.ts's runBacktestOnRealCandles, just driven by a live poll loop
// instead of a historical candle array. One poll interval stands in for
// "one candle" in the exact same time-scaling math backtest.ts already
// uses (see tuning.ts's REAL_*_PER_HOUR constants), so this engine inherits
// the already-validated calibration instead of being a fresh,
// unvalidated reimplementation.
//
// No env var, no API key, no signing, no order-placement call anywhere in
// this file. Real execution would be a separate, explicitly-scoped
// addition — never built silently alongside a "paper mode" request.

import { discoverKrakenAssets, fetchKrakenTicker, type KrakenAsset } from './lib/krakenData'
import { clamp, diffs, mean, stdDev, uid } from './lib/math'
import {
  AGENT_BETA,
  ENTRY_REGIME_THRESHOLD,
  LIQUIDITY_DEPTH_USD,
  MAX_ENTRIES_PER_SESSION,
  MAX_POSITIONS,
  MAX_SESSION_DRAWDOWN_PCT,
  MIN_SIGNAL_THRESHOLD,
  REAL_ENTRY_ATTEMPT_CHANCE_PER_HOUR,
  REAL_MOONSHOT_MAX_GAIN,
  REAL_MOONSHOT_MIN_GAIN,
  REAL_MOONSHOT_VOL_MULT,
  REAL_RISK_FLAG_CHANCE_PER_HOUR,
  REAL_STOP_LOSS_MAX_PCT,
  REAL_STOP_LOSS_MIN_PCT,
  REAL_STOP_LOSS_VOL_MULT,
  REAL_TRAIL_ARM_MAX_PCT,
  REAL_TRAIL_ARM_MIN_PCT,
  REAL_TRAIL_ARM_VOL_MULT,
  REAL_TRAIL_GIVEBACK_MAX_PCT,
  REAL_TRAIL_GIVEBACK_MIN_PCT,
  REAL_TRAIL_GIVEBACK_VOL_MULT,
  REAL_TREND_FAST_WINDOW,
  REAL_TREND_MIN_STREAK,
  REAL_TREND_SLOW_WINDOW,
  REAL_VOL_FLOOR,
  REAL_VOL_WINDOW,
  RISK_VETO_CHANCE,
  SEED_EQUITY,
  SESSION_LENGTH_HOURS,
} from './tuning'

// Conservative against Kraken's public rate limit (counter-based, ~15-20
// call budget for an unauthenticated client): one combined Ticker call
// covering every tracked asset, every 20s.
const POLL_INTERVAL_MS = 20_000
const EQUITY_SERIES_LEN = 120
const LOG_MAX = 40
const TRACK_WINDOW = REAL_VOL_WINDOW + REAL_TREND_SLOW_WINDOW

export type KrakenStatus = 'connecting' | 'live' | 'degraded' | 'error'

export interface KrakenPosition {
  id: string
  token: string
  entryPrice: number
  peakPrice: number
  units: number
  notional: number
  entryVol: number
  openedAt: number
}

export interface KrakenLogEntry {
  id: string
  timestamp: number
  token: string
  action: 'BUY' | 'SELL'
  pnl: number | null
  reason: string
}

export interface KrakenPaperState {
  status: KrakenStatus
  statusDetail?: string
  assets: KrakenAsset[]
  prices: Record<string, number>
  equity: number
  equitySeries: number[]
  wins: number
  losses: number
  fills: number
  positions: KrakenPosition[]
  log: KrakenLogEntry[]
  ticketCeilingBlocks: number
  killSwitchBlocks: number
  polls: number
}

interface AssetTrack {
  closes: number[]
  vol: number
  trendUpStreak: number
}

export type KrakenListener = (state: KrakenPaperState) => void

class KrakenPaperEngine {
  private assets: KrakenAsset[] = []
  private tracks: Record<string, AssetTrack> = {}
  private marketFactor = 0
  private scoutVal = 0
  private sentimentVal = 0
  private whaleVal = 0

  private equity = SEED_EQUITY
  private equitySeries: number[] = [SEED_EQUITY]
  private wins = 0
  private losses = 0
  private fills = 0
  private positions: KrakenPosition[] = []
  private log: KrakenLogEntry[] = []
  private ticketCeilingBlocks = 0
  private killSwitchBlocks = 0
  private polls = 0

  private sessionStartAt = Date.now()
  private sessionStartEquity = SEED_EQUITY
  private sessionEntries = 0

  private status: KrakenStatus = 'connecting'
  private statusDetail: string | undefined

  private timer: ReturnType<typeof setTimeout> | null = null
  private listeners = new Set<KrakenListener>()
  private started = false

  // Time-scaled exactly like backtest.ts's real-data mode (see the module
  // comment there and in tuning.ts) — a live poll here plays the role a
  // historical candle plays there.
  private readonly hourFraction = POLL_INTERVAL_MS / 3_600_000
  private readonly entryChancePerTick = 1 - Math.pow(1 - REAL_ENTRY_ATTEMPT_CHANCE_PER_HOUR, this.hourFraction)
  private readonly riskFlagChancePerTick = 1 - Math.pow(1 - REAL_RISK_FLAG_CHANCE_PER_HOUR, this.hourFraction)

  start(onTick: KrakenListener) {
    this.listeners.add(onTick)
    if (!this.started) {
      this.started = true
      this.bootstrap()
    }
    onTick(this.snapshot())
    return () => {
      this.listeners.delete(onTick)
    }
  }

  stop() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private async bootstrap() {
    try {
      this.assets = await discoverKrakenAssets()
      for (const a of this.assets) this.tracks[a.label] = { closes: [], vol: REAL_VOL_FLOOR, trendUpStreak: 0 }
      if (this.assets.length === 0) {
        this.setStatus('error', 'no tracked assets are listed on Kraken')
        this.pushOut()
        return
      }
    } catch (e) {
      this.setStatus('error', e instanceof Error ? e.message : 'failed to discover Kraken pairs')
      this.pushOut()
      return
    }
    this.poll()
  }

  private setStatus(status: KrakenStatus, detail?: string) {
    this.status = status
    this.statusDetail = detail
  }

  private slippageFor(notional: number): number {
    return clamp(0.0012 + notional / LIQUIDITY_DEPTH_USD, 0.0002, 0.08)
  }

  private recordFill(token: string, action: 'BUY' | 'SELL', pnl: number | null, reason: string) {
    this.fills += 1
    if (pnl !== null) {
      this.equity += pnl
      if (pnl > 0) this.wins += 1
      else this.losses += 1
    }
    const entry: KrakenLogEntry = { id: uid(), timestamp: Date.now(), token, action, pnl, reason }
    this.log = [entry, ...this.log].slice(0, LOG_MAX)
  }

  private async poll() {
    this.polls += 1
    try {
      const ticks = await fetchKrakenTicker(this.assets)
      const resolved = Object.keys(ticks).length
      if (resolved === this.assets.length) this.setStatus('live')
      else if (resolved > 0) this.setStatus('degraded', `${resolved}/${this.assets.length} pairs resolved`)
      else this.setStatus('error', 'no pairs resolved — check network/CORS')

      if (resolved > 0) this.tick(ticks)
    } catch (e) {
      this.setStatus('error', e instanceof Error ? e.message : 'Kraken poll failed')
    }

    this.pushOut()
    this.scheduleNext()
  }

  private scheduleNext() {
    this.timer = setTimeout(() => this.poll(), POLL_INTERVAL_MS)
  }

  private tick(ticks: Record<string, { price: number }>) {
    if (Date.now() - this.sessionStartAt >= SESSION_LENGTH_HOURS * 60 * 60 * 1000) {
      this.sessionStartAt = Date.now()
      this.sessionStartEquity = this.equity
      this.sessionEntries = 0
    }

    const zScores: number[] = []
    for (const asset of this.assets) {
      const price = ticks[asset.label]?.price
      const track = this.tracks[asset.label]
      if (price === undefined || !track) continue

      track.closes.push(price)
      if (track.closes.length > TRACK_WINDOW) track.closes = track.closes.slice(-TRACK_WINDOW)

      if (track.closes.length >= 2) {
        const returns = diffs(track.closes).map((d, i) => d / track.closes[i])
        const window = returns.slice(-REAL_VOL_WINDOW)
        track.vol = window.length >= 5 ? stdDev(window) || REAL_VOL_FLOOR : REAL_VOL_FLOOR
        zScores.push(clamp(returns[returns.length - 1] / track.vol, -5, 5))

        const fastMa = mean(track.closes.slice(-REAL_TREND_FAST_WINDOW))
        const slowMa = mean(track.closes.slice(-REAL_TREND_SLOW_WINDOW))
        track.trendUpStreak = price > fastMa && fastMa > slowMa ? track.trendUpStreak + 1 : 0
      }
    }

    const zAvg = zScores.length > 0 ? mean(zScores) : 0
    this.marketFactor = clamp(this.marketFactor + zAvg * 0.03 - this.marketFactor * 0.06, -1, 1)
    this.scoutVal = clamp(this.scoutVal + AGENT_BETA.scout * this.marketFactor * 0.8 + zAvg * 0.7 - this.scoutVal * 0.05, -40, 40)
    this.sentimentVal = clamp(
      this.sentimentVal + AGENT_BETA.sentiment * this.marketFactor * 0.8 + zAvg * 0.7 - this.sentimentVal * 0.05,
      -40,
      40,
    )
    this.whaleVal = clamp(
      this.whaleVal + AGENT_BETA.whalewatch * this.marketFactor * 0.8 + zAvg * 0.7 - this.whaleVal * 0.05,
      -40,
      40,
    )

    // RISK: occasionally force-closes the worst open position.
    if (this.positions.length > 0 && Math.random() < this.riskFlagChancePerTick) {
      let worstIdx = 0
      let worstPnl = Infinity
      this.positions.forEach((p, idx) => {
        const price = ticks[p.token]?.price ?? p.entryPrice
        const pnl = (price - p.entryPrice) * p.units
        if (pnl < worstPnl) {
          worstPnl = pnl
          worstIdx = idx
        }
      })
      const [closed] = this.positions.splice(worstIdx, 1)
      const price = ticks[closed.token]?.price ?? closed.entryPrice
      const exitPrice = price * (1 - this.slippageFor(closed.units * price))
      this.recordFill(closed.token, 'SELL', (exitPrice - closed.entryPrice) * closed.units, 'rug risk flagged — exited')
    }

    // EXIT: stop-loss / moonshot safety cap / trailing stop, ATR-sized off
    // the volatility observed when each position was opened.
    for (let i = this.positions.length - 1; i >= 0; i--) {
      const p = this.positions[i]
      const price = ticks[p.token]?.price
      if (price === undefined) continue
      p.peakPrice = Math.max(p.peakPrice, price)

      const stopPct = clamp(p.entryVol * REAL_STOP_LOSS_VOL_MULT, REAL_STOP_LOSS_MIN_PCT, REAL_STOP_LOSS_MAX_PCT)
      const trailArmPct = clamp(p.entryVol * REAL_TRAIL_ARM_VOL_MULT, REAL_TRAIL_ARM_MIN_PCT, REAL_TRAIL_ARM_MAX_PCT)
      const trailGivebackPct = clamp(
        p.entryVol * REAL_TRAIL_GIVEBACK_VOL_MULT,
        REAL_TRAIL_GIVEBACK_MIN_PCT,
        REAL_TRAIL_GIVEBACK_MAX_PCT,
      )
      const moonshotMult = 1 + clamp(p.entryVol * REAL_MOONSHOT_VOL_MULT, REAL_MOONSHOT_MIN_GAIN, REAL_MOONSHOT_MAX_GAIN)

      let reason: string | null = null
      if (price <= p.entryPrice * (1 - stopPct)) reason = 'stop-loss triggered'
      else if (price >= p.entryPrice * moonshotMult) reason = 'take-profit target hit'
      else if (price > p.entryPrice * (1 + trailArmPct) && price <= p.peakPrice * (1 - trailGivebackPct)) {
        reason = 'trailing stop executed'
      }

      if (reason) {
        this.positions.splice(i, 1)
        const exitPrice = price * (1 - this.slippageFor(p.units * price))
        this.recordFill(p.token, 'SELL', (exitPrice - p.entryPrice) * p.units, reason)
      }
    }

    // SNIPER: same regime gate, per-asset trend-confirmation gate, risk
    // veto and session containment as the validated real-data backtest —
    // extended to pick unbiased among whichever tracked assets currently
    // confirm a trend, since live paper mode covers several real assets at
    // once instead of backtest.ts's one-asset-per-run scope.
    if (this.positions.length < MAX_POSITIONS && Math.random() < this.entryChancePerTick && this.marketFactor > ENTRY_REGIME_THRESHOLD) {
      const killSwitchActive = this.equity <= this.sessionStartEquity * (1 - MAX_SESSION_DRAWDOWN_PCT / 100)
      if (killSwitchActive) {
        this.killSwitchBlocks += 1
      } else if (this.sessionEntries >= MAX_ENTRIES_PER_SESSION) {
        this.ticketCeilingBlocks += 1
      } else if (Math.random() >= 0.5 * RISK_VETO_CHANCE) {
        const heldTokens = new Set(this.positions.map((p) => p.token))
        const candidates = this.assets.filter((a) => {
          const track = this.tracks[a.label]
          return track && ticks[a.label]?.price !== undefined && !heldTokens.has(a.label) && track.trendUpStreak >= REAL_TREND_MIN_STREAK
        })
        if (candidates.length > 0) {
          const asset = candidates[Math.floor(Math.random() * candidates.length)]
          const price = ticks[asset.label].price
          const track = this.tracks[asset.label]
          const signal = (this.scoutVal + this.sentimentVal + this.whaleVal) / 3
          if (signal > MIN_SIGNAL_THRESHOLD) {
            const sizeFrac = clamp(0.03 + signal * 0.006, 0.015, 0.12)
            const notional = this.equity * sizeFrac
            const entryPrice = price * (1 + this.slippageFor(notional))
            this.positions.push({
              id: uid(),
              token: asset.label,
              entryPrice,
              peakPrice: entryPrice,
              units: notional / entryPrice,
              notional,
              entryVol: track.vol,
              openedAt: Date.now(),
            })
            this.recordFill(asset.label, 'BUY', null, 'entry signal triggered')
            this.sessionEntries += 1
          }
        }
      }
    }

    this.equitySeries =
      this.equitySeries.length >= EQUITY_SERIES_LEN ? [...this.equitySeries.slice(1), this.equity] : [...this.equitySeries, this.equity]
  }

  private snapshot(): KrakenPaperState {
    const prices: Record<string, number> = {}
    for (const [label, track] of Object.entries(this.tracks)) {
      if (track.closes.length > 0) prices[label] = track.closes[track.closes.length - 1]
    }
    return {
      status: this.status,
      statusDetail: this.statusDetail,
      assets: this.assets,
      prices,
      equity: this.equity,
      equitySeries: this.equitySeries,
      wins: this.wins,
      losses: this.losses,
      fills: this.fills,
      positions: this.positions.map((p) => ({ ...p })),
      log: this.log,
      ticketCeilingBlocks: this.ticketCeilingBlocks,
      killSwitchBlocks: this.killSwitchBlocks,
      polls: this.polls,
    }
  }

  private pushOut() {
    const state = this.snapshot()
    this.listeners.forEach((l) => l(state))
  }
}

export const krakenPaperEngine = new KrakenPaperEngine()
