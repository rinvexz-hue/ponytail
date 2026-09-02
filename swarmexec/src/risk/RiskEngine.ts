import type { RiskCapsConfig } from "../config/index.js";
import type { Intent, Mode, Order, RiskDecision } from "../types.js";
import type { SignalDeduper } from "../util/dedupe.js";
import type { KillSwitch } from "../util/killswitch.js";
import type { GraduationTracker } from "./graduation.js";

/** A hard gate that can only reject or pass — never resize or approve-with-changes. */
export interface HardGate {
  name: string;
  check(intent: Intent): Promise<{ pass: true } | { pass: false; detail: string }>;
}

/**
 * Rolling risk state: trade timestamps for the hourly rate limit, realized
 * daily P&L for the circuit breaker, and current capital at risk across
 * open positions. This is intentionally separate from RiskEngine so it can
 * be a single shared instance the position manager also writes to.
 */
export class RiskState {
  private tradeTimestamps: number[] = [];
  private dailyRealizedPnlUsd = 0;
  private dailyWindowStart = RiskState.dayStart(Date.now());
  private capitalAtRiskUsd = 0;

  private static dayStart(now: number): number {
    const d = new Date(now);
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime();
  }

  private rollDailyWindowIfNeeded(now: number): void {
    const today = RiskState.dayStart(now);
    if (today !== this.dailyWindowStart) {
      this.dailyWindowStart = today;
      this.dailyRealizedPnlUsd = 0;
    }
  }

  recordEntryTrade(now: number = Date.now()): void {
    this.tradeTimestamps.push(now);
  }

  tradesInLastHour(now: number = Date.now()): number {
    const cutoff = now - 60 * 60 * 1000;
    this.tradeTimestamps = this.tradeTimestamps.filter((t) => t > cutoff);
    return this.tradeTimestamps.length;
  }

  recordRealizedPnl(pnlUsd: number, now: number = Date.now()): void {
    this.rollDailyWindowIfNeeded(now);
    this.dailyRealizedPnlUsd += pnlUsd;
  }

  dailyPnlUsd(now: number = Date.now()): number {
    this.rollDailyWindowIfNeeded(now);
    return this.dailyRealizedPnlUsd;
  }

  circuitBreakerTripped(caps: RiskCapsConfig, now: number = Date.now()): boolean {
    return this.dailyPnlUsd(now) <= -Math.abs(caps.maxDailyLossUsd);
  }

  setCapitalAtRisk(usd: number): void {
    this.capitalAtRiskUsd = usd;
  }

  capitalAtRisk(): number {
    return this.capitalAtRiskUsd;
  }
}

export interface RiskEngineDeps {
  caps: RiskCapsConfig;
  mode: Mode;
  killSwitch: KillSwitch;
  deduper: SignalDeduper;
  graduation: GraduationTracker;
  state: RiskState;
  /** Hard gates run only for new entries (rug risk, price agreement, ...). */
  entryGates: HardGate[];
}

let orderCounter = 0;
function nextOrderId(): string {
  orderCounter += 1;
  return `order_${Date.now()}_${orderCounter}`;
}

/**
 * The one place an Intent is allowed to become an Order. Every check here
 * can only reject or shrink sizeUsd — nothing in this file can make an
 * order bigger than what the strategy asked for, and nothing outside this
 * file can skip it.
 */
export class RiskEngine {
  constructor(private readonly deps: RiskEngineDeps) {}

  async evaluate(intent: Intent, now: number = Date.now()): Promise<RiskDecision> {
    const { caps, mode, killSwitch, deduper, graduation, state, entryGates } = this.deps;

    if (killSwitch.isActive()) {
      return this.reject("KILL_SWITCH_ACTIVE", "Kill switch is active; no new orders accepted.");
    }

    if (!intent.isExit) {
      if (state.circuitBreakerTripped(caps, now)) {
        return this.reject(
          "DAILY_LOSS_CIRCUIT_BREAKER",
          `Daily realized loss ${state.dailyPnlUsd(now).toFixed(2)} breached ` +
            `-${caps.maxDailyLossUsd}; new entries halted until UTC day rolls over.`,
        );
      }

      if (deduper.isDuplicate(intent.mint, intent.side, now)) {
        return this.reject(
          "DUPLICATE_SIGNAL",
          `Duplicate ${intent.side} signal for ${intent.token} within dedupe window.`,
        );
      }

      if (state.tradesInLastHour(now) >= caps.maxTradesPerHour) {
        return this.reject(
          "MAX_TRADES_PER_HOUR",
          `Already ${state.tradesInLastHour(now)} entries in the last hour ` +
            `(cap ${caps.maxTradesPerHour}).`,
        );
      }

      if (graduation.requiresGraduation(mode) && !graduation.isGraduated(intent.strategyId, caps, now)) {
        return this.reject(
          "STRATEGY_NOT_GRADUATED",
          `Strategy "${intent.strategyId}" has not met the PAPER graduation ` +
            `bar (${caps.graduationMinDays}d / ${caps.graduationMinTrades} trades).`,
        );
      }

      for (const gate of entryGates) {
        const result = await gate.check(intent);
        if (!result.pass) {
          const reason = gate.name === "price-agreement" ? "PRICE_SOURCES_DISAGREE" : "RUG_CHECK_FAILED";
          return this.reject(reason, `${gate.name}: ${result.detail}`);
        }
      }
    }

    const sizeUsd = intent.isExit
      ? intent.sizeUsd
      : this.capEntrySize(intent.sizeUsd, caps, state.capitalAtRisk());

    if (!intent.isExit && sizeUsd <= 0) {
      return this.reject(
        "ZERO_SIZE_AFTER_CAPS",
        `Total capital at risk (${state.capitalAtRisk().toFixed(2)}) already at or ` +
          `above cap (${caps.maxTotalCapitalAtRiskUsd}); no room for a new position.`,
      );
    }

    const order: Order = {
      id: nextOrderId(),
      intentId: intent.id,
      strategyId: intent.strategyId,
      token: intent.token,
      mint: intent.mint,
      side: intent.side,
      sizeUsd,
      maxSlippageBps: Math.min(intent.maxSlippageBps, caps.maxSlippageBps),
      isExit: intent.isExit ?? false,
      createdAt: now,
    };

    if (!intent.isExit) {
      deduper.record(intent.mint, intent.side, now);
      state.recordEntryTrade(now);
    }

    return { approved: true, order };
  }

  private capEntrySize(requestedUsd: number, caps: RiskCapsConfig, capitalAtRiskUsd: number): number {
    const perPositionCapped = Math.min(requestedUsd, caps.maxUsdPerPosition);
    const remainingTotalCapacity = caps.maxTotalCapitalAtRiskUsd - capitalAtRiskUsd;
    return Math.max(0, Math.min(perPositionCapped, remainingTotalCapacity));
  }

  private reject(
    reason: Extract<RiskDecision, { approved: false }>["reason"],
    detail: string,
  ): RiskDecision {
    return { approved: false, reason, detail };
  }
}
