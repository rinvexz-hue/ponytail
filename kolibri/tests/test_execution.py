"""Order lifecycle + chaos: partial fills, fill-after-cancel, duplicate / out-of-order updates, rejects,
stop protection, reconciliation, restart mid-position. The invariant throughout: a position is
never left without an exchange-side stop, and anything unexplainable raises an alarm."""

from __future__ import annotations

import asyncio
from decimal import Decimal as D

from conftest import T0, Harness, cheap, intent

from kolibri.core.config import Config, with_overrides
from kolibri.core.models import OrderStatus, OrderType
from kolibri.executioner.executioner import Executioner

S = "BTCUSDT"


def filled_long(h: Harness, qty: str = "1") -> None:
    h.tick(S, T0 - 1000, "100.05")
    h.open(intent(), qty=qty, touch="100.00")
    h.tick(S, T0 + 100, "99.99")  # not active yet (latency 150 ms)
    assert S not in h.exe.positions
    h.tick(S, T0 + 200, "99.99")  # trades through 100.00 -> fill


def reduce_only(cfg: Config) -> Config:
    return with_overrides(cfg, {"venues.binance.supports_reduce_only": True})


def test_entry_fill_places_stop_and_tp1(cfg: Config) -> None:
    h = Harness(reduce_only(cfg))
    filled_long(h)
    pos = h.exe.positions[S]
    assert pos.qty == D("1") and pos.entry == D("100")
    stops = h.stop_order(S)
    assert len(stops) == 1 and stops[0].qty == D("1") and stops[0].stop_price == D("99")
    tps = [o for o in h.exe.open_orders(S) if o.purpose == "tp1"]
    assert len(tps) == 1 and tps[0].qty == D("0.5") and tps[0].price == D("101")


def test_post_only_never_fills_at_touch_only_through(cfg: Config) -> None:
    h = Harness(cfg)
    h.tick(S, T0 - 1000, "100.05")
    h.open(intent(), touch="100.00")
    h.tick(S, T0 + 1000, "100.00")  # trades AT the level: queue position unknown -> no fill
    assert S not in h.exe.positions


def test_tp1_moves_stop_to_breakeven_plus_fees_then_stop_closes(cfg: Config) -> None:
    h = Harness(reduce_only(cfg))
    filled_long(h)
    h.tick(S, T0 + 1000, "101.01")  # TP1 fills half
    pos = h.exe.positions[S]
    assert pos.tp1_done and pos.qty == D("0.5")
    assert pos.stop == D("100.15")  # 100 * (1 + 0.00075 + 0.00075), rounded up to tick
    h.tick(S, T0 + 2000, "100.50")
    stops = h.stop_order(S)
    assert len(stops) == 1 and stops[0].qty == D("0.5") and stops[0].stop_price == D("100.15")
    h.tick(S, T0 + 3000, "100.10")
    assert S not in h.exe.positions
    t = h.closed[0]
    assert t.pnl > 0 and t.r > 0 and t.exit_reason == "trail"


def test_stop_out_is_minus_one_r_plus_costs(cfg: Config) -> None:
    h = Harness(cfg)
    filled_long(h)
    h.tick(S, T0 + 1000, "99.00")
    t = h.closed[0]
    assert t.exit_reason == "stop"
    # 1R of price distance plus both fees (0.075 % each side on a 1 % stop = 0.15R) and slippage
    assert D("-1.2") < t.r < D("-1.15")
    h.tick(S, T0 + 1_500, "99.00")  # TP1 cancel lands after latency: no orphaned order
    assert not h.exe.open_orders(S)


def test_gap_through_stop_fills_at_worse_price(cfg: Config) -> None:
    h = Harness(cfg)
    filled_long(h)
    h.tick(S, T0 + 1000, "97.00")
    assert h.closed[0].r < D("-2.9")


def test_time_stop(cfg: Config) -> None:
    h = Harness(cfg)
    filled_long(h)
    h.tick(S, T0 + 300_000, "100.20")
    assert S in h.exe.positions
    h.tick(S, T0 + 601_000, "100.20")  # 10 min, MFE 0.2R < 0.5R -> market exit
    h.tick(S, T0 + 602_000, "100.20")
    assert h.closed and h.closed[0].exit_reason == "time_stop"


def test_runner_trails_and_never_widens(cfg: Config) -> None:
    h = Harness(reduce_only(cfg))
    filled_long(h)
    h.tick(S, T0 + 1000, "101.01")
    h.tick(S, T0 + 2000, "103.00")
    asyncio.run(h.exe.on_bar(S, D("1"), T0 + 2000))
    assert h.exe.positions[S].stop == D("101.50")
    h.tick(S, T0 + 3000, "102.00")
    asyncio.run(h.exe.on_bar(S, D("1"), T0 + 3000))
    assert h.exe.positions[S].stop == D("101.50")  # price fell back: stop did not move down


def test_entry_timeout_reprices_once_then_abandons(cfg: Config) -> None:
    h = Harness(cfg)
    h.tick(S, T0 - 1000, "100.05")
    h.open(intent(atr="1"), touch="100.00")
    h.tick(S, T0 + 5_000, "100.05")  # timeout -> cancel, near -> reprice pending
    h.tick(S, T0 + 5_200, "100.05")  # cancel effective -> new entry at 100.04
    entries = [o for o in h.exe.orders.values() if o.purpose == "entry"]
    assert len(entries) == 2 and entries[1].price == D("100.04")
    h.tick(S, T0 + 10_300, "100.05")
    h.tick(S, T0 + 10_500, "100.05")
    assert S not in h.exe.entries and S not in h.exe.positions
    assert h.j.query("entry_abandoned")


def test_no_chasing_when_price_ran_away(cfg: Config) -> None:
    h = Harness(cfg)
    h.tick(S, T0 - 1000, "100.05")
    h.open(intent(atr="1"), touch="100.00")
    h.tick(S, T0 + 5_000, "100.60")  # moved > 0.3 ATR -> abandon, no reprice
    h.tick(S, T0 + 5_200, "100.60")
    assert len([o for o in h.exe.orders.values() if o.purpose == "entry"]) == 1
    assert S not in h.exe.entries


def test_fill_after_cancel_race_still_protected(cfg: Config) -> None:
    h = Harness(cfg)
    h.tick(S, T0 - 1000, "100.05")
    h.open(intent(atr="1"), touch="100.00")
    h.tick(S, T0 + 5_000, "100.50")  # we cancel (abandon) ...
    h.tick(S, T0 + 5_100, "99.90")  # ... but it fills before the cancel lands
    h.tick(S, T0 + 5_400, "99.95")
    assert S in h.exe.positions and not h.alarms
    assert h.stop_order(S) and h.exe.positions[S].tp_qty == D("0.5")  # stop rests, synthetic TP1 armed


def test_partial_fills_keep_stop_sized_to_position(cfg: Config) -> None:
    h = Harness(cfg)
    h.broker.partial_fills = True
    filled_long(h)
    assert h.exe.positions[S].qty == D("0.5")
    h.tick(S, T0 + 400, "99.99")
    h.tick(S, T0 + 700, "99.99")
    assert h.exe.positions[S].qty == D("1")
    h.tick(S, T0 + 900, "99.99")
    stops = h.stop_order(S)
    assert [s.qty for s in stops] == [D("1")]


def test_duplicate_and_reversed_updates_are_idempotent(cfg: Config) -> None:
    for knob in ("duplicate_updates", "reverse_delivery"):
        h = Harness(cfg)
        setattr(h.broker, knob, True)
        filled_long(h)
        h.tick(S, T0 + 500, "100.00")
        assert h.exe.positions[S].qty == D("1"), knob
        assert not h.alarms, knob


def test_delayed_fill_reports(cfg: Config) -> None:
    h = Harness(cfg)
    h.broker.extra_fill_delay_ms = 2_000
    filled_long(h)
    assert S not in h.exe.positions
    h.tick(S, T0 + 2_300, "99.99")
    assert S in h.exe.positions  # stop requested; venue-side after latency
    h.tick(S, T0 + 2_600, "99.99")
    assert h.stop_order(S)


def test_three_consecutive_rejects_raise_alarm(cfg: Config) -> None:
    h = Harness(cfg)
    h.broker.reject_next = 3
    for i, sym in enumerate(("BTCUSDT", "ETHUSDT", "SOLUSDT")):
        h.tick(sym, T0 - 1000, "100.05")
        h.open(intent(sym=sym), touch="100.00", now=T0 + i)
    h.tick(S, T0 + 500, "100.05")
    assert any("consecutive order rejects" in a for a in h.alarms)


def test_stop_rejected_raises_alarm(cfg: Config) -> None:
    h = Harness(cfg)
    h.tick(S, T0 - 1000, "100.05")
    h.open(intent(), touch="100.00")
    h.tick(S, T0 + 160, "100.05")  # entry acked
    h.broker.reject_next = 1  # next placement (the protective stop) is rejected
    h.tick(S, T0 + 200, "99.99")
    h.tick(S, T0 + 400, "99.99")
    assert any("protective stop rejected" in a for a in h.alarms)


def test_venue_cancels_our_stop_we_restore_it(cfg: Config) -> None:
    h = Harness(cfg)
    filled_long(h)
    h.tick(S, T0 + 500, "100.00")
    sid = h.exe.stop_id[S]
    asyncio.run(h.broker.cancel(sid, S, T0 + 600))  # e.g. venue-side expiry
    h.tick(S, T0 + 800, "100.00")
    h.tick(S, T0 + 1000, "100.00")
    assert h.exe.stop_id[S] != sid and h.stop_order(S)


def test_flatten_cancels_everything_and_exits(cfg: Config) -> None:
    h = Harness(cfg)
    filled_long(h)
    asyncio.run(h.exe.flatten_all("kill", T0 + 500))
    h.tick(S, T0 + 700, "100.10")
    assert not h.exe.positions and not h.exe.open_orders(S)
    assert h.closed[0].exit_reason == "kill"
    assert h.broker.base[S] == 0


def test_reconcile_unexpected_position_is_flattened(cfg: Config) -> None:
    h = Harness(cfg)
    h.tick("ETHUSDT", T0, "100")
    h.broker.base["ETHUSDT"] = D("2")
    assert asyncio.run(h.exe.reconcile(T0)) == []  # first sighting: could be an in-flight fill
    problems = asyncio.run(h.exe.reconcile(T0 + 30_000))
    assert problems and "unexpected position" in problems[0]
    h.tick("ETHUSDT", T0 + 30_500, "100")
    assert h.broker.base["ETHUSDT"] == 0


def test_restart_mid_position_ends_flat_and_consistent(cfg: Config) -> None:
    h = Harness(cfg)
    filled_long(h)
    h.tick(S, T0 + 500, "100.00")
    # process restarts: new executioner, same venue state (position + its old stop + tp)
    exe2 = Executioner(cfg, h.broker, h.j, h.closed.append, lambda r, t: h.alarms.append(r),
                       lambda: h.broker.equity(exe2.marks))
    exe2.marks[S] = D("100")
    asyncio.run(exe2.reconcile(T0 + 1000))
    problems = asyncio.run(exe2.reconcile(T0 + 31_000))
    assert any("unexpected position" in p for p in problems)
    for ts in (T0 + 31_200, T0 + 31_400):
        h.broker.on_price(S, ts, D("100"))
        asyncio.run(exe2.pump(ts))
    assert h.broker.base[S] == 0 and not exe2.positions
    assert not any(lv.order.open for lv in h.broker.orders.values())


def test_reconcile_restores_missing_stop(cfg: Config) -> None:
    h = Harness(cfg)
    filled_long(h)
    h.tick(S, T0 + 500, "100")
    for lv in h.broker.orders.values():  # venue silently lost our stop
        if lv.order.purpose == "stop":
            lv.order.status = OrderStatus.CANCELED
    asyncio.run(h.exe.reconcile(T0 + 10_000))
    h.tick(S, T0 + 10_300, "100")
    assert h.stop_order(S)


def test_idempotent_client_ids(cfg: Config) -> None:
    h = Harness(cheap(cfg))
    filled_long(h)
    ids = [o.client_id for o in h.exe.orders.values()]
    assert len(ids) == len(set(ids)) and all(len(i) <= 36 for i in ids)
    o = next(iter(h.exe.orders.values()))
    n = len(h.broker.orders)
    asyncio.run(h.broker.place(o, T0 + 900))  # resubmission of an existing id is a no-op
    assert len(h.broker.orders) == n


def test_spot_tp_is_synthetic_and_never_oversells(cfg: Config) -> None:
    """Spot (no reduce-only): only the stop rests; TP1 fires as a market exit after the stop is pulled."""
    h = Harness(cfg)
    filled_long(h)
    h.tick(S, T0 + 400, "100.50")
    resting = [lv.order for lv in h.broker.orders.values() if lv.order.open and lv.order.side.value == "sell"]
    assert [o.purpose for o in resting] == ["stop"]  # never more resting sell qty than we hold
    h.tick(S, T0 + 1000, "101.01")  # through TP1 -> cancel stop + market 50 %
    h.tick(S, T0 + 1200, "101.00")
    pos = h.exe.positions[S]
    assert pos.tp1_done and pos.qty == D("0.5") and pos.stop == D("100.15")
    h.tick(S, T0 + 1500, "101.00")
    resting = [lv.order for lv in h.broker.orders.values() if lv.order.open]
    assert [(o.purpose, o.qty) for o in resting] == [("stop", D("0.5"))]
    tp_fill = next(o for o in h.exe.orders.values() if o.purpose == "tp1")
    assert tp_fill.type is OrderType.MARKET  # honest cost model: taker, not maker


def test_spot_mean_reversion_target_exits_everything(cfg: Config) -> None:
    h = Harness(cfg)
    h.tick(S, T0 - 1000, "100.05")
    h.open(intent(tp1="100.60", full_exit=True), touch="100.00")
    h.tick(S, T0 + 200, "99.99")
    h.tick(S, T0 + 1000, "100.61")
    h.tick(S, T0 + 1200, "100.61")
    assert not h.exe.positions and h.closed[0].exit_reason == "tp1"


def test_kill_with_pending_entry_that_fills_late_ends_flat(cfg: Config) -> None:
    h = Harness(cfg)
    h.tick(S, T0 - 1000, "100.05")
    h.open(intent(), touch="100.00")
    h.tick(S, T0 + 300, "100.05")
    asyncio.run(h.exe.flatten_all("kill", T0 + 400))  # cancel requested ...
    h.tick(S, T0 + 450, "99.90")  # ... entry fills before the cancel lands
    h.tick(S, T0 + 700, "99.90")
    h.tick(S, T0 + 900, "99.90")
    assert not h.exe.positions and h.broker.base[S] == 0
    assert h.closed[0].exit_reason == "kill"


def test_order_rate_budget(cfg: Config) -> None:
    h = Harness(cfg)
    for i in range(5):
        h.exe.placed_ts.append(T0 + i)
    assert h.exe.orders_last_minute(T0 + 10) == 5
    assert h.exe.orders_last_minute(T0 + 61_000) == 0
