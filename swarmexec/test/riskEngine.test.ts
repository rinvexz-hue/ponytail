import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RISK_CAPS, type RiskCapsConfig } from "../src/config/index.js";
import { GraduationTracker } from "../src/risk/graduation.js";
import { RiskEngine, RiskState, type HardGate } from "../src/risk/RiskEngine.js";
import type { Intent } from "../src/types.js";
import { SignalDeduper } from "../src/util/dedupe.js";
import { KillSwitch } from "../src/util/killswitch.js";

function makeIntent(overrides: Partial<Intent> = {}): Intent {
  return {
    id: `intent_${Math.random()}`,
    strategyId: "test-strategy",
    signalId: "sig_1",
    token: "TEST",
    mint: overrides.mint ?? `mint_${Math.random()}`,
    side: "BUY",
    sizeUsd: 1000,
    maxSlippageBps: 100,
    reasoning: "test",
    createdAt: Date.now(),
    ...overrides,
  };
}

function setup(capsOverrides: Partial<RiskCapsConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "swarmexec-test-"));
  const caps: RiskCapsConfig = { ...DEFAULT_RISK_CAPS, ...capsOverrides };
  const killSwitch = new KillSwitch(join(dir, "KILL"));
  const deduper = new SignalDeduper(caps.signalDedupeWindowMs);
  const graduation = new GraduationTracker(dir);
  const state = new RiskState();
  const passGate: HardGate = { name: "pass-through", check: async () => ({ pass: true }) };
  const engine = new RiskEngine({
    caps,
    mode: "PAPER",
    killSwitch,
    deduper,
    graduation,
    state,
    entryGates: [passGate],
  });
  return { engine, caps, killSwitch, deduper, graduation, state };
}

describe("RiskEngine", () => {
  it("approves a well-formed entry and caps size to maxUsdPerPosition", async () => {
    const { engine, caps } = setup({ maxUsdPerPosition: 50, maxTotalCapitalAtRiskUsd: 1000 });
    const decision = await engine.evaluate(makeIntent({ sizeUsd: 500 }));
    expect(decision.approved).toBe(true);
    if (decision.approved) expect(decision.order.sizeUsd).toBe(caps.maxUsdPerPosition);
  });

  it("rejects once the hourly trade rate limit is hit, exits unaffected", async () => {
    const { engine, state } = setup({ maxTradesPerHour: 2, maxTotalCapitalAtRiskUsd: 10_000 });
    const first = await engine.evaluate(makeIntent({ mint: "mintA" }));
    const second = await engine.evaluate(makeIntent({ mint: "mintB" }));
    const third = await engine.evaluate(makeIntent({ mint: "mintC" }));
    expect(first.approved).toBe(true);
    expect(second.approved).toBe(true);
    expect(third.approved).toBe(false);
    if (!third.approved) expect(third.reason).toBe("MAX_TRADES_PER_HOUR");

    // Exits must never be blocked by the entry rate limit.
    state.setCapitalAtRisk(0);
    const exit = await engine.evaluate(makeIntent({ mint: "mintD", side: "SELL", isExit: true }));
    expect(exit.approved).toBe(true);
  });

  it("trips the daily-loss circuit breaker and halts new entries only", async () => {
    const { engine, state } = setup({ maxDailyLossUsd: 100 });
    state.recordRealizedPnl(-150);
    const entry = await engine.evaluate(makeIntent({ mint: "mintA" }));
    expect(entry.approved).toBe(false);
    if (!entry.approved) expect(entry.reason).toBe("DAILY_LOSS_CIRCUIT_BREAKER");

    const exit = await engine.evaluate(makeIntent({ mint: "mintB", side: "SELL", isExit: true }));
    expect(exit.approved).toBe(true);
  });

  it("rejects a duplicate signal for the same mint+side within the dedupe window", async () => {
    const { engine } = setup({ signalDedupeWindowMs: 60_000 });
    const first = await engine.evaluate(makeIntent({ mint: "mintX" }));
    const second = await engine.evaluate(makeIntent({ mint: "mintX" }));
    expect(first.approved).toBe(true);
    expect(second.approved).toBe(false);
    if (!second.approved) expect(second.reason).toBe("DUPLICATE_SIGNAL");
  });

  it("blocks everything, including exits, while the kill switch is active", async () => {
    const { engine, killSwitch } = setup();
    killSwitch.trip("HALT", "test");
    const entry = await engine.evaluate(makeIntent({ mint: "mintA" }));
    const exit = await engine.evaluate(makeIntent({ mint: "mintB", side: "SELL", isExit: true }));
    expect(entry.approved).toBe(false);
    expect(exit.approved).toBe(false);
    if (!entry.approved) expect(entry.reason).toBe("KILL_SWITCH_ACTIVE");
  });

  it("rejects a new entry with zero room once total capital-at-risk cap is hit", async () => {
    const { engine, state } = setup({ maxTotalCapitalAtRiskUsd: 100 });
    state.setCapitalAtRisk(100);
    const decision = await engine.evaluate(makeIntent({ mint: "mintA" }));
    expect(decision.approved).toBe(false);
    if (!decision.approved) expect(decision.reason).toBe("ZERO_SIZE_AFTER_CAPS");
  });

  it("requires graduation before LIVE_CAPPED entries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swarmexec-test-"));
    const caps = { ...DEFAULT_RISK_CAPS, maxTotalCapitalAtRiskUsd: 10_000 };
    const killSwitch = new KillSwitch(join(dir, "KILL"));
    const deduper = new SignalDeduper(caps.signalDedupeWindowMs);
    const graduation = new GraduationTracker(dir);
    const state = new RiskState();
    const engine = new RiskEngine({
      caps,
      mode: "LIVE_CAPPED",
      killSwitch,
      deduper,
      graduation,
      state,
      entryGates: [],
    });
    const decision = await engine.evaluate(makeIntent({ mint: "mintA" }));
    expect(decision.approved).toBe(false);
    if (!decision.approved) expect(decision.reason).toBe("STRATEGY_NOT_GRADUATED");
  });

  it("rejects an entry when a hard gate (e.g. rug check) fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swarmexec-test-"));
    const caps = { ...DEFAULT_RISK_CAPS };
    const killSwitch = new KillSwitch(join(dir, "KILL"));
    const deduper = new SignalDeduper(caps.signalDedupeWindowMs);
    const graduation = new GraduationTracker(dir);
    const state = new RiskState();
    const failingGate: HardGate = {
      name: "rug-check",
      check: async () => ({ pass: false, detail: "mint authority not renounced" }),
    };
    const engine = new RiskEngine({
      caps,
      mode: "PAPER",
      killSwitch,
      deduper,
      graduation,
      state,
      entryGates: [failingGate],
    });
    const decision = await engine.evaluate(makeIntent({ mint: "mintA" }));
    expect(decision.approved).toBe(false);
    if (!decision.approved) expect(decision.reason).toBe("RUG_CHECK_FAILED");
  });
});
