"""Analyst: regime -> setups -> hard gates -> soft score -> Intent | Rejection.

Pure: features in, intents/rejections out. No network, no clock, no randomness. Gates 7 (cooldown)
and 8 (risk approval) belong to the Risk Officer, which the Desk consults right after this."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from decimal import Decimal

from kolibri.analyst.features import Features, session_of
from kolibri.core.config import Config, SymbolCfg
from kolibri.core.models import (
    MINUTE_MS,
    Book,
    Candidate,
    Direction,
    Intent,
    Regime,
    Rejection,
    bps,
    ceil_to,
    floor_to,
)

LONG, SHORT = Direction.LONG, Direction.SHORT


@dataclass(frozen=True, slots=True)
class Health:
    tick_age_s: float = 0.0
    clock_drift_ms: float = 0.0
    connected: bool = True


def clamp(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))


def classify(f: Features | None, cfg: Config) -> Regime:
    rc, gates = cfg.regime, cfg.gates
    if f is None or not f.warm:
        return Regime.WARMUP
    if (
        f.rv_pct > rc.chaos_rv_pct
        or (f.spread_bps is not None and f.spread_bps > float(gates.max_spread_bps))
        or (f.depth_usd is not None and f.depth_usd < float(rc.min_depth_usd))
    ):
        return Regime.CHAOS
    if f.bw_pct <= rc.squeeze_pct:
        return Regime.SQUEEZE
    if f.adx > rc.adx_trend and f.ema9 > f.ema21 > f.ema50 and f.bias_15m > 0:
        return Regime.TREND_UP
    if f.adx > rc.adx_trend and f.ema9 < f.ema21 < f.ema50 and f.bias_15m < 0:
        return Regime.TREND_DOWN
    if f.adx < rc.adx_range and f.bw_pct < 0.5 and f.vwap_crosses >= 2:
        return Regime.RANGE
    return Regime.NEUTRAL


# ---- setups: return (candidate-building inputs) or None ------------------------------------
Trigger = tuple[float, float | None, bool]  # structure stop, fixed target, htf_exempt


def setup_a(f: Features, d: Direction, cfg: Config) -> Trigger | None:
    """Trend pullback to EMA21/VWAP with RSI(7) reset and a reclaim candle."""
    s, st, buf = d.sign, cfg.strategy, float(cfg.strategy.structure_buffer_atr) * f.atr
    if d is LONG:
        touched = f.low5 <= max(f.ema21, f.vwap) + 0.1 * f.atr
        reset = st.rsi_reset_low <= f.rsi7_min3 <= st.rsi_reset_high
    else:
        touched = f.high5 >= min(f.ema21, f.vwap) - 0.1 * f.atr
        reset = 100 - st.rsi_reset_high <= f.rsi7_max3 <= 100 - st.rsi_reset_low
    reclaim = s * (f.close - f.open) > 0 and s * (f.close - f.ema21) > 0 and f.volz > 0
    ok = touched and reset and s * (f.rsi7 - f.rsi7_prev) > 0 and f.cvd_div != -s and reclaim
    if not ok:
        return None
    return (f.low5 - buf if d is LONG else f.high5 + buf), None, False


def setup_b(f: Features, d: Direction, cfg: Config) -> Trigger | None:
    """Range mean-reversion: band / VWAP-deviation overshoot, RSI extreme, CVD exhaustion."""
    s, st, buf = d.sign, cfg.strategy, float(cfg.strategy.structure_buffer_atr) * f.atr
    if d is LONG:
        stretched = f.low <= f.bb_lower or f.close <= f.vwap - 1.5 * f.atr
        extreme = f.rsi7_min3 <= st.rsi_extreme
    else:
        stretched = f.high >= f.bb_upper or f.close >= f.vwap + 1.5 * f.atr
        extreme = f.rsi7_max3 >= 100 - st.rsi_extreme
    ok = stretched and extreme and f.cvd_div == s and s * (f.close - f.open) > 0 and s * (f.vwap - f.close) > 0
    if not ok:
        return None
    return (f.low5 - buf if d is LONG else f.high5 + buf), f.vwap, False


def setup_c(f: Features, d: Direction, cfg: Config) -> Trigger | None:
    """Breakout from a recent squeeze: close beyond the band on volume, flow confirming."""
    s, st, buf = d.sign, cfg.strategy, float(cfg.strategy.structure_buffer_atr) * f.atr
    if f.bars_since_squeeze > cfg.regime.squeeze_memory_bars:
        return None
    beyond = f.close > f.bb_upper if d is LONG else f.close < f.bb_lower
    imb = f.imbalance10
    book_ok = imb is None or (imb >= 0.55 if d is LONG else imb <= 0.45)
    flow = s * f.bar_delta > 0 and s * (f.taker_ratio - 0.5) > 0
    if not (beyond and f.volz > st.breakout_volz and flow and book_ok):
        return None
    stop = max(f.low, f.bb_mid) - buf if d is LONG else min(f.high, f.bb_mid) + buf
    return stop, None, False


def setup_d(f: Features, d: Direction, cfg: Config) -> Trigger | None:
    """Liquidity sweep reversal through a swing / prior-day level, CVD flip, volume spike."""
    s, buf = d.sign, float(cfg.strategy.structure_buffer_atr) * f.atr
    if d is LONG:
        level = min(f.swing_low, f.prev_day_low) if f.prev_day_low is not None else f.swing_low
        swept = f.low < level < f.close
    else:
        level = max(f.swing_high, f.prev_day_high) if f.prev_day_high is not None else f.swing_high
        swept = f.high > level > f.close
    flip = s * f.bar_delta > 0 and s * f.prev_bar_delta < 0
    if not (swept and flip and s * (f.close - f.open) > 0 and f.volz > cfg.strategy.sweep_volz):
        return None
    return (f.low - buf if d is LONG else f.high + buf), None, True


SETUPS: dict[str, Callable[[Features, Direction, Config], Trigger | None]] = {
    "A_pullback": setup_a,
    "B_meanrev": setup_b,
    "C_breakout": setup_c,
    "D_sweep": setup_d,
}


def regime_allows(setup: str, d: Direction, regime: Regime, f: Features, cfg: Config) -> bool:
    if regime in (Regime.WARMUP, Regime.CHAOS):
        return False
    if setup == "A_pullback":
        return regime is (Regime.TREND_UP if d is LONG else Regime.TREND_DOWN)
    if setup == "B_meanrev":
        return regime is Regime.RANGE
    if setup == "C_breakout":
        return f.bars_since_squeeze <= cfg.regime.squeeze_memory_bars
    return True  # D: any non-CHAOS regime


def build_candidate(f: Features, setup: str, d: Direction, trig: Trigger, spec: SymbolCfg,
                    cfg: Config) -> Candidate:
    """Round every price against ourselves: entry/TP toward caution, stop away from entry."""
    st = cfg.strategy
    structure_stop, target, exempt = trig
    entry = Decimal(repr(f.close))
    atr = Decimal(repr(f.atr))
    s = d.sign
    stop = Decimal(repr(structure_stop))
    if (entry - stop) * s < st.stop_atr_min * atr:  # too tight = noise stop; widen to the floor
        stop = entry - s * st.stop_atr_min * atr
    if d is LONG:
        entry, stop = floor_to(entry, spec.tick), floor_to(stop, spec.tick)
    else:
        entry, stop = ceil_to(entry, spec.tick), ceil_to(stop, spec.tick)
    risk = abs(entry - stop)
    tp1 = entry + s * risk
    # Final target comes from the 4h picture: the next 4h level, set a hair in front of it.
    # Mean reversion keeps its VWAP target unless the 4h level is closer. No level ahead (price beyond
    # the 4h range) = no fixed target: the runner trails.
    level = f.hi_4h if d is LONG else f.lo_4h
    level_ahead = (level - f.close) * s > 0
    in_front = level - s * 0.1 * f.atr
    if level_ahead:
        nearer = min if d is LONG else max
        target = in_front if target is None else nearer(target, in_front)
    tp2 = Decimal(repr(target)) if target is not None else None
    full_exit = tp2 is not None and (tp2 - entry) * s < risk  # target inside 1R: exit all there
    if tp2 is not None and full_exit:
        tp1, tp2 = tp2, None

    def rnd(x: Decimal) -> Decimal:
        return floor_to(x, spec.tick) if d is LONG else ceil_to(x, spec.tick)

    return Candidate(symbol=f.symbol, setup=setup, direction=d, ts=f.ts, entry=entry, stop=stop,
                     tp1=rnd(tp1), tp2=rnd(tp2) if tp2 is not None else None, atr=atr,
                     htf_exempt=exempt, full_exit=full_exit)


def score(f: Features, c: Candidate, cfg: Config) -> tuple[float, dict[str, float]]:
    s = c.direction.sign
    trending = c.setup in ("A_pullback", "C_breakout")
    comp = {
        "trend": (
            sum((s * (f.ema9 - f.ema21) > 0, s * (f.ema21 - f.ema50) > 0, s * f.bias_15m > 0, s * f.stack_4h > 0,
                 s * f.bias_4h > 0)) / 5
            if trending
            else 0.5
        ),
        "momentum": (
            (1.0 if s * (f.rsi7 - f.rsi7_prev) > 0 else 0.0)
            + (0.5 if f.macd_slope is None else 1.0 if s * f.macd_slope > 0 else 0.0)
        )
        / 2,
        "volume": clamp(f.volz / 2),
        "cvd": ((1.0 if s * f.bar_delta > 0 else 0.0) + clamp(0.5 + s * (f.taker_ratio - 0.5) * 4)) / 2,
        "book": 0.5 if f.imbalance10 is None else clamp(0.5 + s * (f.imbalance10 - 0.5) * 2),
        "cross": clamp(0.5 + s * f.leader_mom5_atr / 4),
        "deriv": 0.5,  # neutral until a derivatives feed (funding / OI / liquidations) is wired
    }
    w = cfg.gates.weights
    total = 100 * sum(w[k] * v for k, v in comp.items()) / sum(w.values())
    return total, comp


def slippage_bps(book: Book | None, spec: SymbolCfg, side_long: bool, qty: Decimal) -> Decimal:
    """Walk the book for `qty` (taker exit worst case); fall back to the configured model."""
    if book is None or not (book.asks if side_long else book.bids):
        return spec.spread_bps / 2 + spec.impact_bps
    levels = book.bids if side_long else book.asks  # exiting a long sells into bids
    mid = (book.bid + book.ask) / 2
    left, cost = qty, Decimal(0)
    for px, q in levels:
        take = min(left, q)
        cost += take * px
        left -= take
        if left <= 0:
            break
    if left > 0:
        return Decimal(10_000)  # book too thin for our size
    avg = cost / qty
    return abs(avg - mid) / mid * 10_000


def in_blackout(ts: int, cfg: Config) -> str | None:
    g = cfg.gates
    for ev in cfg.events:
        ets = int(ev.ts.timestamp() * 1000)
        if abs(ts - ets) <= g.event_blackout_min * MINUTE_MS:
            return f"event:{ev.name}"
    if g.funding_blackout_enabled:
        into = ts % (8 * 60 * MINUTE_MS)
        if min(into, 8 * 60 * MINUTE_MS - into) <= g.funding_blackout_min * MINUTE_MS:
            return "funding"
    if session_of(ts) not in g.sessions_allowed:
        return f"session:{session_of(ts)}"
    return None


class Analyst:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.last_emit: dict[tuple[str, str, Direction], int] = {}
        self.regimes: dict[str, Regime] = {}
        self.gate_status: dict[str, str] = {}  # symbol -> what blocks trading right now

    def evaluate(self, f: Features | None, symbol: str, equity: Decimal, health: Health,
                 book: Book | None) -> list[Intent | Rejection]:
        cfg = self.cfg
        regime = classify(f, cfg)
        self.regimes[symbol] = regime
        if f is None:
            self.gate_status[symbol] = "warmup"
            return []
        self.gate_status[symbol] = "no_setup" if regime not in (Regime.CHAOS,) else "regime:CHAOS"
        out: list[Intent | Rejection] = []
        spec = cfg.symbol_specs[symbol]
        for name, fn in SETUPS.items():
            for d in (LONG, SHORT):
                trig = fn(f, d, cfg)
                if trig is None:
                    continue
                cand = build_candidate(f, name, d, trig, spec, cfg)
                res = self._gates(f, cand, regime, equity, health, book, spec)
                out.append(res)
                self.gate_status[symbol] = "open:" + name if isinstance(res, Intent) else res.gate
        return out

    def _gates(self, f: Features, c: Candidate, regime: Regime, equity: Decimal, health: Health,
               book: Book | None, spec: SymbolCfg) -> Intent | Rejection:
        cfg, g, s = self.cfg, self.cfg.gates, c.direction.sign
        sc, comp = score(f, c, cfg)

        def rej(gate: str, detail: str) -> Rejection:
            return Rejection(c.symbol, c.setup, c.direction, c.ts, gate, detail, sc)

        if c.direction is SHORT and not cfg.venue_cfg.supports_short:
            return rej("0_venue_no_short", "venue does not support shorts")
        key = (c.symbol, c.setup, c.direction)
        bar_ms = cfg.timeframes.signal_minutes * MINUTE_MS
        if c.ts - self.last_emit.get(key, -(10**15)) < g.signal_dedup_bars * bar_ms:
            return rej("0_dedup", "same signal fired recently")
        # 1. regime
        if not regime_allows(c.setup, c.direction, regime, f, cfg):
            return rej("1_regime", regime.value)
        risk = abs(c.entry - c.stop)
        if risk <= 0 or risk > cfg.strategy.stop_atr_max * c.atr:
            return rej("1_stop_distance", f"stop {risk / c.atr:.2f} ATR")
        # 2. top-down: the 4h picture must not oppose the trade, and must leave room to the next level
        if not c.htf_exempt:
            trending = c.setup in ("A_pullback", "C_breakout")
            if s * f.bias_4h < 0 or s * f.stack_4h < 0 or (trending and s * (f.close - f.ema50_4h) < 0):
                return rej("2_htf", f"4h bias={f.bias_4h} stack={f.stack_4h} vs ema50_4h={f.ema50_4h:.6g}")
            if s * f.bias_15m < 0:
                return rej("2_htf", f"15m bias={f.bias_15m}")
        level = Decimal(repr(f.hi_4h if c.direction is LONG else f.lo_4h))
        if (level - c.entry) * s > 0 and (level - c.entry) * s < g.min_room_r * risk:
            return rej("2_4h_room", f"4h level {level} only {(level - c.entry) * s / risk:.2f}R away")
        if c.symbol != cfg.leader and s * f.leader_mom5_atr < -g.btc_block_atr:
            return rej("2_leader", f"leader mom5={f.leader_mom5_atr:.2f} ATR")
        # 3. spread + slippage for our size
        spread = Decimal(repr(f.spread_bps)) if f.spread_bps is not None else spec.spread_bps
        if spread > g.max_spread_bps:
            return rej("3_spread", f"{spread:.2f} bps")
        est_qty = equity * cfg.risk.risk_per_trade_pct / 100 / risk
        slip = slippage_bps(book, spec, c.direction is LONG, est_qty)
        if slip > g.max_slip_bps:
            return rej("3_slippage", f"{slip:.2f} bps")
        # soft score before the cost gate: expected-R is derived from it, so checking it later would
        # make this gate unreachable (every low score would already fail 4_net_r)
        if sc < g.score_threshold:
            return rej("score", f"{sc:.1f} < {g.score_threshold}")
        # 4. cost gate: maker entry + taker exit + exit slippage, both legs
        v = cfg.venue_cfg
        cost = c.entry * v.maker + c.entry * v.taker + c.entry * bps(slip)
        frac = cfg.strategy.tp1_fraction
        tp1_r = abs(c.tp1 - c.entry) / risk
        rest_r = (abs(c.tp2 - c.entry) / risk) if c.tp2 is not None else cfg.strategy.runner_expected_r
        reward = tp1_r if c.full_exit else frac * tp1_r + (1 - frac) * rest_r  # expected gross R if it works
        gross = reward * risk  # the gross target distance, weighted over the TP1 part and the 4h target part
        if gross < g.cost_multiple * cost:
            return rej("4_cost", f"target {gross:.6g} < {g.cost_multiple}x cost {cost:.6g}")
        cost_r = cost / risk
        p = min(Decimal("0.9"), max(Decimal("0.05"),
                g.win_prob_prior + g.win_prob_per_score_pt * Decimal(repr(sc - g.score_threshold))))
        exp_r = p * reward - (1 - p) - cost_r
        if exp_r < g.min_net_r:
            return rej("4_net_r", f"E[R]={exp_r:.3f}")
        # 5. data health
        if f.gap or not health.connected:
            return rej("5_data_gap", "bar gap or disconnected")
        if health.tick_age_s > g.max_tick_age_s:
            return rej("5_stale", f"tick age {health.tick_age_s:.1f}s")
        if abs(health.clock_drift_ms) > g.max_clock_drift_ms:
            return rej("5_clock", f"drift {health.clock_drift_ms:.0f}ms")
        # 6. blackouts / session
        why = in_blackout(c.ts, cfg)
        if why:
            return rej("6_blackout", why)
        self.last_emit[key] = c.ts
        return Intent(candidate=c, score=sc, expected_net_r=exp_r, cost_r=cost_r, components=comp)
