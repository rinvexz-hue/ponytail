import { nextIntentId } from "../strategy/Strategy.js";
import type { Fill, Intent, Position } from "../types.js";

export interface ClosedPosition extends Position {
  exitPrice: number;
  pnlUsd: number;
}

/**
 * Owns the open-position book. Stop-loss/take-profit exits generated here
 * are marked `isExit: true` so the risk layer never rate-limits or
 * dedupe-blocks a position that needs to close — the one thing this
 * system must always be able to do is get out of a trade.
 */
export class PositionManager {
  private readonly positions = new Map<string, Position>();

  /** Call after a BUY fill to open a new position. */
  openFromFill(fill: Fill, strategyId: string, stopLossPct: number, takeProfitPct: number): Position {
    if (fill.side !== "BUY") {
      throw new Error("openFromFill called with a non-BUY fill.");
    }
    const qty = (fill.sizeUsd - fill.feeUsd) / fill.price;
    const position: Position = {
      token: fill.token,
      mint: fill.mint,
      strategyId,
      entryPrice: fill.price,
      sizeUsd: fill.sizeUsd,
      qty,
      openedAt: fill.filledAt,
      stopLossPct,
      takeProfitPct,
    };
    this.positions.set(fill.mint, position);
    return position;
  }

  /** Call after a SELL fill that closes an existing position. */
  closeFromFill(fill: Fill): ClosedPosition | null {
    const position = this.positions.get(fill.mint);
    if (!position) return null;
    this.positions.delete(fill.mint);
    const proceedsUsd = position.qty * fill.price - fill.feeUsd;
    const pnlUsd = proceedsUsd - position.sizeUsd;
    return { ...position, exitPrice: fill.price, pnlUsd };
  }

  getOpenPositions(): Position[] {
    return [...this.positions.values()];
  }

  totalCapitalAtRiskUsd(): number {
    return this.getOpenPositions().reduce((sum, p) => sum + p.sizeUsd, 0);
  }

  /**
   * Checks every open position's live unrealized P&L against its
   * stop-loss/take-profit thresholds and returns exit Intents for any
   * that should close now. Pure given the price map — no I/O here.
   */
  checkExits(currentPrices: ReadonlyMap<string, number>, now: number = Date.now()): Intent[] {
    const exits: Intent[] = [];
    for (const position of this.positions.values()) {
      const price = currentPrices.get(position.mint);
      if (price === undefined) continue;
      const pnlPct = ((price - position.entryPrice) / position.entryPrice) * 100;

      const hitStopLoss = pnlPct <= -Math.abs(position.stopLossPct);
      const hitTakeProfit = pnlPct >= Math.abs(position.takeProfitPct);
      if (!hitStopLoss && !hitTakeProfit) continue;

      exits.push({
        id: nextIntentId(),
        strategyId: position.strategyId,
        signalId: "position-manager-exit",
        token: position.token,
        mint: position.mint,
        side: "SELL",
        sizeUsd: position.sizeUsd,
        maxSlippageBps: 300,
        reasoning: hitStopLoss
          ? `Stop-loss hit: ${pnlPct.toFixed(2)}% <= -${position.stopLossPct}%`
          : `Take-profit hit: ${pnlPct.toFixed(2)}% >= ${position.takeProfitPct}%`,
        createdAt: now,
        isExit: true,
      });
    }
    return exits;
  }
}
