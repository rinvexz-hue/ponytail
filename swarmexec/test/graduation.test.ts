import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_RISK_CAPS } from "../src/config/index.js";
import { GraduationTracker } from "../src/risk/graduation.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "swarmexec-grad-"));
}

describe("GraduationTracker", () => {
  it("is not graduated with zero trades", () => {
    const tracker = new GraduationTracker(tmpDir());
    expect(tracker.isGraduated("strat-a", DEFAULT_RISK_CAPS)).toBe(false);
  });

  it("is not graduated with enough trades but not enough elapsed days", () => {
    const tracker = new GraduationTracker(tmpDir());
    const start = 1_000_000;
    for (let i = 0; i < DEFAULT_RISK_CAPS.graduationMinTrades; i++) {
      tracker.recordPaperTrade("strat-a", start + i);
    }
    // Only a few seconds elapsed, far short of graduationMinDays.
    expect(tracker.isGraduated("strat-a", DEFAULT_RISK_CAPS, start + 5_000)).toBe(false);
  });

  it("graduates once both minimum trades and minimum days are met", () => {
    const tracker = new GraduationTracker(tmpDir());
    const start = 1_000_000;
    for (let i = 0; i < DEFAULT_RISK_CAPS.graduationMinTrades; i++) {
      tracker.recordPaperTrade("strat-a", start + i);
    }
    const later = start + (DEFAULT_RISK_CAPS.graduationMinDays + 1) * 24 * 60 * 60 * 1000;
    expect(tracker.isGraduated("strat-a", DEFAULT_RISK_CAPS, later)).toBe(true);
  });

  it("tracks strategies independently", () => {
    const tracker = new GraduationTracker(tmpDir());
    const start = 1_000_000;
    const later = start + (DEFAULT_RISK_CAPS.graduationMinDays + 1) * 24 * 60 * 60 * 1000;
    for (let i = 0; i < DEFAULT_RISK_CAPS.graduationMinTrades; i++) {
      tracker.recordPaperTrade("strat-a", start + i);
    }
    expect(tracker.isGraduated("strat-a", DEFAULT_RISK_CAPS, later)).toBe(true);
    expect(tracker.isGraduated("strat-b", DEFAULT_RISK_CAPS, later)).toBe(false);
  });

  it("PAPER and TESTNET never require graduation; LIVE_CAPPED and LIVE do", () => {
    const tracker = new GraduationTracker(tmpDir());
    expect(tracker.requiresGraduation("PAPER")).toBe(false);
    expect(tracker.requiresGraduation("TESTNET")).toBe(false);
    expect(tracker.requiresGraduation("LIVE_CAPPED")).toBe(true);
    expect(tracker.requiresGraduation("LIVE")).toBe(true);
  });
});
