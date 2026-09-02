import { describe, expect, it } from "vitest";
import { SignalDeduper } from "../src/util/dedupe.js";

describe("SignalDeduper", () => {
  it("flags a repeat of the same mint+side within the window as a duplicate", () => {
    const deduper = new SignalDeduper(60_000);
    const now = 1_000_000;
    expect(deduper.isDuplicate("mintA", "BUY", now)).toBe(false);
    deduper.record("mintA", "BUY", now);
    expect(deduper.isDuplicate("mintA", "BUY", now + 1_000)).toBe(true);
  });

  it("allows the same mint again once the window has passed", () => {
    const deduper = new SignalDeduper(60_000);
    const now = 1_000_000;
    deduper.record("mintA", "BUY", now);
    expect(deduper.isDuplicate("mintA", "BUY", now + 60_001)).toBe(false);
  });

  it("treats BUY and SELL on the same mint as independent", () => {
    const deduper = new SignalDeduper(60_000);
    const now = 1_000_000;
    deduper.record("mintA", "BUY", now);
    expect(deduper.isDuplicate("mintA", "SELL", now + 1_000)).toBe(false);
  });

  it("prune() drops stale entries", () => {
    const deduper = new SignalDeduper(1_000);
    deduper.record("mintA", "BUY", 0);
    deduper.prune(5_000);
    expect(deduper.isDuplicate("mintA", "BUY", 5_001)).toBe(false);
  });
});
