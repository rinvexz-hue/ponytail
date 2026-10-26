"""Risk Officer: property tests for sizing / heat, plus limits, cooldowns, halts and config consistency."""

from __future__ import annotations

from decimal import Decimal as D

import pytest
from conftest import T0, intent
from hypothesis import given, settings
from hypothesis import strategies as st
from pydantic import ValidationError

from kolibri.core.config import Config, load_config, with_overrides
from kolibri.core.journal import Journal
from kolibri.core.models import ClosedTrade, Direction, Position, Rejection, bps
from kolibri.risk.officer import DAY_MS, Approval, RiskOfficer, utc_week

CFG = load_config()
SYMS = list(CFG.symbols)


def officer(cfg: Config = CFG, equity: str = "10000") -> RiskOfficer:
    return RiskOfficer(cfg, Journal(), D(equity))


def pos(sym: str, entry: str = "100", stop: str = "99", qty: str = "1", d: Direction = Direction.LONG) -> Position:
    return Position(sym, d, "A_pullback", D(qty), D(entry), D(stop), D(stop), D(entry), None, D("1"), T0,
                    initial_qty=D(qty))


prices = st.decimals(min_value=D("0.5"), max_value=D("100000"), places=2)


@settings(max_examples=300, deadline=None)
@given(entry=prices, stop_frac=st.decimals(D("0.0005"), D("0.05"), places=4),
       equity=st.decimals(D("100"), D("1000000"), places=2), sym=st.sampled_from(SYMS))
def test_sizing_never_exceeds_risk_cap_and_respects_filters(entry: D, stop_frac: D, equity: D, sym: str) -> None:
    spec = CFG.symbol_specs[sym]
    e = (entry // spec.tick) * spec.tick
    s = ((e * (1 - stop_frac)) // spec.tick) * spec.tick
    if s <= 0 or s >= e:
        return
    r = officer(equity=str(equity))
    res = r.review(intent(sym=sym, entry=str(e), stop=str(s), tp1=str(e + (e - s))), [], {}, {}, T0)
    if isinstance(res, Rejection):
        assert res.gate.startswith("8_risk")
        return
    v = CFG.venue_cfg
    per_unit = (e - s) + e * v.maker + s * (v.taker + bps(spec.spread_bps / 2 + spec.impact_bps))
    assert res.qty * per_unit <= equity * CFG.risk.risk_per_trade_pct / 100  # risk incl. costs <= 0.25 %
    assert res.qty % spec.step == 0  # lot step
    assert res.qty * e >= spec.min_notional
    assert res.qty * e <= equity * v.max_leverage  # never levered


@settings(max_examples=200, deadline=None)
@given(n_open=st.integers(0, 3), stop_pcts=st.lists(st.decimals(D("0.001"), D("0.03"), places=4), min_size=4,
                                                    max_size=4), corr=st.floats(0, 1))
def test_heat_cap_never_breached(n_open: int, stop_pcts: list[D], corr: float) -> None:
    r = officer(with_overrides(CFG, {"risk.max_same_direction": 4}), "10000")
    opened: list[Position] = []
    for i in range(n_open):
        sym = SYMS[i]
        res = r.review(intent(sym=sym, entry="100", stop=str(100 - 100 * stop_pcts[i]),
                              tp1="110"), opened, {s: corr for s in SYMS}, {}, T0)
        if isinstance(res, Approval):
            opened.append(pos(sym, "100", str(100 - 100 * stop_pcts[i]), str(res.qty)))
    heat = r.heat(opened, {s: corr for s in SYMS})
    assert heat <= r.equity * CFG.risk.heat_cap_pct / 100


def test_position_limits_and_correlation(cfg: Config) -> None:
    r = officer()
    two_longs = [pos("ETHEUR", qty="0.01"), pos("SOLEUR", qty="0.01")]
    res = r.review(intent(sym="XRPEUR"), two_longs, {}, {}, T0)
    assert isinstance(res, Rejection) and res.gate == "8_risk_same_direction"
    res = r.review(intent(sym="ETHEUR"), [pos("ETHEUR", qty="0.01")], {}, {}, T0)
    assert isinstance(res, Rejection) and res.gate == "8_risk_symbol_busy"
    res = r.review(intent(sym="BTCEUR"), [], {}, {"ETHEUR": (1, D(10)), "SOLEUR": (1, D(10))}, T0)
    assert isinstance(res, Rejection) and res.gate == "8_risk_same_direction"  # pending entries count
    # correlated same-direction legs weigh 1.5x
    legs = [pos("ETHEUR", qty="10"), pos("SOLEUR", qty="10")]
    assert r.heat(legs, {"ETHEUR": 0.9, "SOLEUR": 0.9}) == D("30")
    assert r.heat(legs, {"ETHEUR": 0.5, "SOLEUR": 0.5}) == D("20")


def test_trades_per_day_cap() -> None:
    r = officer()
    for _ in range(CFG.risk.max_trades_per_day):
        r.on_entry()
    res = r.review(intent(), [], {}, {}, T0)
    assert isinstance(res, Rejection) and res.gate == "8_risk_trades_day"


def test_daily_weekly_drawdown_limits_and_persistence() -> None:
    j = Journal()
    r = RiskOfficer(CFG, j, D("10000"))
    assert r.on_equity(D("10000"), T0) is None
    reason, until = r.on_equity(D("9799"), T0 + 1000)  # -2.01 % on the day
    assert reason.startswith("daily_loss") and until == T0 + DAY_MS
    r.set_halt(reason, T0 + 1000, until)
    r2 = RiskOfficer(CFG, j, D("9799"))  # restart: halt survives
    assert r2.halted(T0 + 2000) == reason
    assert r2.halted(T0 + DAY_MS) is None  # expires next UTC day
    # weekly -5 % -> manual
    r3 = officer()
    monday = T0 - 4 * DAY_MS  # T0 is a Friday; weeks start Monday 00:00 UTC
    assert utc_week(monday) == utc_week(monday + 6 * DAY_MS) != utc_week(monday - 1)
    r3.on_equity(D("10000"), monday)
    for day in range(1, 4):  # -1.8 %/day: never trips the daily limit, but the week does
        r3.on_equity(D(10000 - 180 * day), monday + day * DAY_MS)
    breach = r3.on_equity(D("9490"), monday + 3 * DAY_MS + 1)
    assert breach is not None and breach[0].startswith("weekly") and breach[1] is None
    # -8 % from peak -> manual, and a manual halt is never downgraded
    r4 = officer()
    r4.on_equity(D("12000"), T0)
    breach = r4.on_equity(D("11039"), T0 + 7 * DAY_MS + 1)
    assert breach is not None and breach[0].startswith("max_drawdown")
    r4.set_halt(breach[0], T0, None)
    r4.set_halt("daily_loss", T0, T0 + 10)
    assert r4.halt is not None and r4.halt["until"] is None
    res = r4.review(intent(), [], {}, {}, T0 + 100)
    assert isinstance(res, Rejection) and res.gate == "8_risk_halt"
    r4.rearm(T0 + 200)
    assert r4.halted(T0 + 300) is None


def _trade(pnl: str, reason: str = "stop", ts: int = T0) -> ClosedTrade:
    return ClosedTrade("BTCEUR", "A_pullback", Direction.LONG, ts, ts, D(100), D(1), D(pnl), D(0), D(pnl), reason,
                       D(10000))


def test_cooldowns() -> None:
    r, rk = officer(), CFG.risk
    r.on_trade_closed(_trade("-1"))
    res = r.review(intent(), [], {}, {}, T0 + 60_000)
    assert isinstance(res, Rejection) and res.gate == "7_cooldown"
    assert not isinstance(r.review(intent(), [], {}, {}, T0 + rk.stopout_cooldown_s * 1000 + 1), Rejection)
    for _ in range(3):
        r.on_trade_closed(_trade("-1", reason="time_stop"))
    res = r.review(intent(sym="ETHEUR"), [], {}, {}, T0 + rk.loss_streak_cooldown_s * 500)
    assert isinstance(res, Rejection) and res.detail == "global loss-streak cooldown"
    after = T0 + rk.loss_streak_cooldown_s * 1000 + 1
    assert not isinstance(r.review(intent(sym="ETHEUR"), [], {}, {}, after), Rejection)


def test_config_consistency_is_enforced() -> None:
    assert CFG.risk.risk_per_trade_pct * CFG.risk.max_positions == CFG.risk.heat_cap_pct
    with pytest.raises(ValidationError):
        with_overrides(CFG, {"risk.heat_cap_pct": "2.0"})  # > 4 x 0.25
    with pytest.raises(ValidationError):
        with_overrides(CFG, {"risk.daily_loss_pct": "6"})  # daily must be < weekly
    with pytest.raises(ValidationError):
        with_overrides(CFG, {"gates.weights": {"trend": 1}})
    with pytest.raises(ValidationError):
        with_overrides(CFG, {"tunable": ["strategy.nope"]})
    with pytest.raises(ValidationError):
        with_overrides(CFG, {"risk.max_positions": 1})  # max_same_direction 2 > 1 would be dead


def test_config_is_frozen() -> None:
    with pytest.raises(ValidationError):
        CFG.risk.risk_per_trade_pct = D("5")  # type: ignore[misc]
