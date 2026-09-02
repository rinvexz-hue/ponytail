import { describe, expect, it } from "vitest";
import { PositionManager } from "../src/position/PositionManager.js";
import type { Fill } from "../src/types.js";

function buyFill(overrides: Partial<Fill> = {}): Fill {
  return {
    id: "fill_1",
    orderId: "order_1",
    token: "TEST",
    mint: "mintA",
    side: "BUY",
    sizeUsd: 100,
    price: 1,
    feeUsd: 0,
    slippageBps: 0,
    mode: "PAPER",
    filledAt: 1_000,
    ...overrides,
  };
}

describe("PositionManager", () => {
  it("opens a position from a BUY fill and tracks capital at risk", () => {
    const pm = new PositionManager();
    pm.openFromFill(buyFill(), "strat-a", 25, 50);
    expect(pm.getOpenPositions()).toHaveLength(1);
    expect(pm.totalCapitalAtRiskUsd()).toBe(100);
  });

  it("closes a position from a SELL fill and computes realized P&L", () => {
    const pm = new PositionManager();
    pm.openFromFill(buyFill({ price: 1, sizeUsd: 100 }), "strat-a", 25, 50);
    const closed = pm.closeFromFill(
      buyFill({ id: "fill_2", side: "SELL", price: 1.5, sizeUsd: 100, feeUsd: 1 }),
    );
    expect(closed).not.toBeNull();
    expect(closed!.pnlUsd).toBeCloseTo(150 - 1 - 100, 5);
    expect(pm.getOpenPositions()).toHaveLength(0);
  });

  it("returns null when closing a mint with no open position", () => {
    const pm = new PositionManager();
    expect(pm.closeFromFill(buyFill({ side: "SELL", mint: "unknown" }))).toBeNull();
  });

  it("generates a SELL exit intent when stop-loss is breached", () => {
    const pm = new PositionManager();
    pm.openFromFill(buyFill({ price: 1, sizeUsd: 100 }), "strat-a", 25, 50);
    const exits = pm.checkExits(new Map([["mintA", 0.7]]), 2_000);
    expect(exits).toHaveLength(1);
    expect(exits[0]!.side).toBe("SELL");
    expect(exits[0]!.isExit).toBe(true);
    expect(exits[0]!.reasoning).toMatch(/Stop-loss/);
  });

  it("generates a SELL exit intent when take-profit is hit", () => {
    const pm = new PositionManager();
    pm.openFromFill(buyFill({ price: 1, sizeUsd: 100 }), "strat-a", 25, 50);
    const exits = pm.checkExits(new Map([["mintA", 1.6]]), 2_000);
    expect(exits).toHaveLength(1);
    expect(exits[0]!.reasoning).toMatch(/Take-profit/);
  });

  it("does not generate an exit while price is within SL/TP bounds", () => {
    const pm = new PositionManager();
    pm.openFromFill(buyFill({ price: 1, sizeUsd: 100 }), "strat-a", 25, 50);
    const exits = pm.checkExits(new Map([["mintA", 1.1]]), 2_000);
    expect(exits).toHaveLength(0);
  });
});
