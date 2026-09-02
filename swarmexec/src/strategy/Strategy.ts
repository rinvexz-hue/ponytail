import type { RiskCapsConfig } from "../config/index.js";
import type { Intent, Position, Signal } from "../types.js";

export interface StrategyContext {
  /** Currently open positions across the whole portfolio, read-only. */
  openPositions: readonly Position[];
  /** Read-only view of risk caps — a strategy can reason about them but never change them. */
  caps: Readonly<RiskCapsConfig>;
  now: number;
}

/**
 * A strategy is a pure function: (signal, context) -> Intent | null.
 * No network calls, no file I/O, no mutation of shared state. That
 * purity is what makes strategies trivially unit-testable and safe to
 * backtest by replaying historical signals through them.
 */
export interface Strategy {
  id: string;
  decide(signal: Signal, context: StrategyContext): Intent | null;
}

let intentCounter = 0;
export function nextIntentId(): string {
  intentCounter += 1;
  return `intent_${Date.now()}_${intentCounter}`;
}
