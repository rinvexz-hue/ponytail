"""Risk Officer: sizing, exposure, loss limits, cooldowns, halts. Has veto power over everything.

Halts are persisted in the journal state table, so a restart can never silently clear them.
Config is frozen at startup, so no reload can loosen limits mid-trade."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from kolibri.core.config import Config
from kolibri.core.journal import Journal
from kolibri.core.models import (
    D0,
    MINUTE_MS,
    ClosedTrade,
    Intent,
    Position,
    Rejection,
    bps,
    floor_to,
)

DAY_MS = 1440 * MINUTE_MS
WEEK_MS = 7 * DAY_MS
EPOCH_MONDAY_OFFSET = 3 * DAY_MS  # 1970-01-01 was a Thursday; weeks start Monday 00:00 UTC


def utc_day(ts: int) -> int:
    return ts // DAY_MS


def utc_week(ts: int) -> int:
    return (ts + EPOCH_MONDAY_OFFSET) // WEEK_MS


@dataclass(frozen=True, slots=True)
class Approval:
    qty: Decimal
    risk_amount: Decimal  # money at risk incl. fees + slippage if the stop fills


class RiskOfficer:
    def __init__(self, cfg: Config, journal: Journal, equity: Decimal) -> None:
        self.cfg, self.j = cfg, journal
        self.equity = equity
        self.peak = Decimal(journal.get_state("peak_equity") or str(equity))
        self.day, self.day_start = journal.get_state("day_anchor", [-1, str(equity)])
        self.day_start = Decimal(self.day_start)
        self.week, self.week_start = journal.get_state("week_anchor") or [-1, str(equity)]
        self.week_start = Decimal(self.week_start)
        self.halt: dict[str, object] | None = journal.get_state("halt")
        self.trades_today: int = journal.get_state("trades_today", 0)
        self.loss_streak: int = journal.get_state("loss_streak", 0)
        self.global_cooldown_until: int = journal.get_state("global_cooldown_until", 0)
        self.cooldowns: dict[str, int] = journal.get_state("cooldowns", {})
        self.canary_notional: Decimal | None = None  # set when graduation only unlocks the canary stage
        self._persisted_ts = 0

    # ---- halts -----------------------------------------------------------------------------
    def halted(self, ts: int) -> str | None:
        h = self.halt
        if h is None:
            return None
        until = h.get("until")
        if isinstance(until, int) and ts >= until:
            self.halt = None
            self.j.set_state("halt", None)
            self.j.emit("risk", ts, event="halt_expired")
            return None
        return str(h["reason"])

    def set_halt(self, reason: str, ts: int, until: int | None) -> None:
        """until=None -> manual re-arm required."""
        if self.halt is not None and self.halt.get("until") is None and until is not None:
            return  # never downgrade a manual halt to a timed one
        self.halt = {"reason": reason, "since": ts, "until": until}
        self.j.set_state("halt", self.halt)

    def rearm(self, ts: int) -> None:
        self.halt = None
        self.j.set_state("halt", None)
        self.peak = self.equity  # drawdown is measured from the re-arm point
        self.week, self.week_start = utc_week(ts), self.equity
        self._persist()
        self.j.emit("risk", ts, event="rearmed")

    def reset_anchors(self, equity: Decimal, ts: int) -> None:
        """Start of a fresh journal: peak / day / week anchors at the real starting equity."""
        self.equity = self.peak = self.day_start = self.week_start = equity
        self.day, self.week = utc_day(ts), utc_week(ts)
        self._persist()

    # ---- equity / limits -------------------------------------------------------------------
    def on_equity(self, equity: Decimal, ts: int) -> tuple[str, int | None] | None:
        """Mark-to-market update. Returns (reason, halt_until) when a loss limit is breached."""
        self.equity = equity
        day, week = utc_day(ts), utc_week(ts)
        rolled = day != self.day or week != self.week
        if day != self.day:
            self.day, self.day_start, self.trades_today = day, equity, 0
            self.cooldowns = {}
        if week != self.week:
            self.week, self.week_start = week, equity
        changed = equity > self.peak
        self.peak = max(self.peak, equity)
        r = self.cfg.risk
        breach: tuple[str, int | None] | None = None
        if equity <= self.peak * (1 - r.max_drawdown_pct / 100):
            breach = (f"max_drawdown {r.max_drawdown_pct}%", None)
        elif equity <= self.week_start * (1 - r.weekly_loss_pct / 100):
            breach = (f"weekly_loss {r.weekly_loss_pct}%", None)
        elif equity <= self.day_start * (1 - r.daily_loss_pct / 100):
            breach = (f"daily_loss {r.daily_loss_pct}%", (day + 1) * DAY_MS)
        if rolled or breach or (changed and ts - self._persisted_ts >= 5_000):
            self._persisted_ts = ts
            self._persist()
        return breach

    def _persist(self) -> None:
        s = self.j.set_state
        s("peak_equity", str(self.peak))
        s("day_anchor", [self.day, str(self.day_start)])
        s("week_anchor", [self.week, str(self.week_start)])
        s("trades_today", self.trades_today)
        s("loss_streak", self.loss_streak)
        s("global_cooldown_until", self.global_cooldown_until)
        s("cooldowns", self.cooldowns)

    def on_trade_closed(self, t: ClosedTrade) -> None:
        r = self.cfg.risk
        if t.pnl < 0:
            self.loss_streak += 1
            if t.exit_reason == "stop":
                self.cooldowns[t.symbol] = t.closed_ts + r.stopout_cooldown_s * 1000
            if self.loss_streak >= r.loss_streak:
                self.global_cooldown_until = t.closed_ts + r.loss_streak_cooldown_s * 1000
                self.loss_streak = 0
                self.j.emit("risk", t.closed_ts, event="loss_streak_cooldown")
        else:
            self.loss_streak = 0
        self._persist()

    def on_entry(self) -> None:
        self.trades_today += 1
        self._persist()

    # ---- gates 7 + 8 -----------------------------------------------------------------------
    def review(self, intent: Intent, positions: list[Position], corr: dict[str, float],
               pending: dict[str, tuple[int, Decimal]], ts: int) -> Approval | Rejection:
        """`pending`: symbol -> (direction sign, approved risk) of entries not yet (fully) filled."""
        c, r, cfg = intent.candidate, self.cfg.risk, self.cfg

        def veto(gate: str, detail: str) -> Rejection:
            return Rejection(c.symbol, c.setup, c.direction, c.ts, gate, detail, intent.score)

        if ts < self.global_cooldown_until:
            return veto("7_cooldown", "global loss-streak cooldown")
        if ts < self.cooldowns.get(c.symbol, 0):
            return veto("7_cooldown", "symbol stop-out cooldown")
        why = self.halted(ts)
        if why:
            return veto("8_risk_halt", why)
        if self.trades_today >= r.max_trades_per_day:
            return veto("8_risk_trades_day", str(self.trades_today))
        if c.symbol in pending or any(p.symbol == c.symbol for p in positions):
            return veto("8_risk_symbol_busy", "position or entry already open")
        if len(positions) + len(pending) >= r.max_positions:
            return veto("8_risk_max_positions", str(len(positions) + len(pending)))
        same = sum(1 for p in positions if p.direction is c.direction)
        same += sum(1 for sign, _ in pending.values() if sign == c.direction.sign)
        if same >= r.max_same_direction:
            return veto("8_risk_same_direction", str(same))

        v = cfg.venue_cfg
        spec = cfg.symbol_specs[c.symbol]
        slip = bps(spec.spread_bps / 2 + spec.impact_bps)
        per_unit = abs(c.entry - c.stop) + c.entry * v.maker + c.stop * (v.taker + slip)
        risk_amount = self.equity * r.risk_per_trade_pct / 100
        qty = floor_to(risk_amount / per_unit, spec.step)
        # Never lever up to reach the risk budget: cap size at the notional headroom instead
        # (risk then lands below 0.25 %, never above). 2 % buffer keeps fees payable.
        gross_open = sum((p.qty * p.entry for p in positions), D0)
        headroom = v.max_leverage * self.equity * Decimal("0.98") - gross_open
        qty = max(D0, min(qty, floor_to(headroom / c.entry, spec.step)))
        if self.canary_notional is not None:  # canary: real orders, deliberately tiny
            qty = min(qty, floor_to(self.canary_notional / c.entry, spec.step))
        if qty <= 0 or qty < spec.min_qty or qty * c.entry < spec.min_notional:
            return veto("8_risk_min_notional", f"qty {qty}")
        notional = qty * c.entry
        net = sum((p.direction.sign * p.qty * p.entry for p in positions), D0) + c.direction.sign * notional
        if abs(net) > r.max_net_exposure * self.equity:
            return veto("8_risk_net_exposure", f"net {net:.2f}")
        extra = [(sym, sign, risk) for sym, (sign, risk) in pending.items()]
        heat = self.heat(positions, corr, extra=[*extra, (c.symbol, c.direction.sign, qty * per_unit)])
        if heat > r.heat_cap_pct / 100 * self.equity:
            return veto("8_risk_heat", f"heat {heat:.2f}")
        return Approval(qty=qty, risk_amount=qty * per_unit)

    def heat(self, positions: list[Position], corr: dict[str, float],
             extra: list[tuple[str, int, Decimal]] | None = None) -> Decimal:
        """Open risk; correlated same-direction positions count corr_heat_multiplier x."""
        r = self.cfg.risk
        legs = [(p.symbol, p.direction.sign, p.open_risk()) for p in positions]
        legs += extra or []
        total = D0
        for sym, sign, risk in legs:
            peers = sum(1 for s2, g2, _ in legs if s2 != sym and g2 == sign)
            mult = r.corr_heat_multiplier if peers and corr.get(sym, 0.0) > r.corr_threshold else Decimal(1)
            total += risk * mult
        return total
