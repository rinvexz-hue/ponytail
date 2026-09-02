import { describe, expect, it } from "vitest";
import { DEFAULT_RISK_CAPS } from "../src/config/index.js";
import { NewPairMomentumStrategy } from "../src/strategy/NewPairMomentumStrategy.js";
import type { Signal } from "../src/types.js";

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: "sig_1",
    source: "test",
    token: "TEST",
    mint: "mintA",
    kind: "NEW_PAIR",
    observedAt: 1_000,
    payload: { liquidityUsd: 10_000, volume24hUsd: 20_000 },
    ...overrides,
  };
}

describe("NewPairMomentumStrategy", () => {
  const strategy = new NewPairMomentumStrategy();
  const context = { openPositions: [], caps: DEFAULT_RISK_CAPS, now: 1_000 };

  it("emits a BUY intent for a qualifying new pair", () => {
    const intent = strategy.decide(makeSignal(), context);
    expect(intent).not.toBeNull();
    expect(intent?.side).toBe("BUY");
    expect(intent?.sizeUsd).toBe(DEFAULT_RISK_CAPS.maxUsdPerPosition);
  });

  it("ignores signals below the liquidity/volume bar", () => {
    const intent = strategy.decide(
      makeSignal({ payload: { liquidityUsd: 100, volume24hUsd: 100 } }),
      context,
    );
    expect(intent).toBeNull();
  });

  it("ignores non-NEW_PAIR signal kinds", () => {
    const intent = strategy.decide(makeSignal({ kind: "SENTIMENT_SPIKE" }), context);
    expect(intent).toBeNull();
  });

  it("refuses to double-enter a token it already holds", () => {
    const contextWithPosition = {
      ...context,
      openPositions: [
        {
          token: "TEST",
          mint: "mintA",
          strategyId: strategy.id,
          entryPrice: 1,
          sizeUsd: 50,
          qty: 50,
          openedAt: 0,
          stopLossPct: 25,
          takeProfitPct: 50,
        },
      ],
    };
    const intent = strategy.decide(makeSignal(), contextWithPosition);
    expect(intent).toBeNull();
  });

  it("is a pure function: same input always yields an equivalent decision", () => {
    const a = strategy.decide(makeSignal(), context);
    const b = strategy.decide(makeSignal(), context);
    expect(a?.side).toBe(b?.side);
    expect(a?.sizeUsd).toBe(b?.sizeUsd);
    expect(a?.mint).toBe(b?.mint);
  });
});
