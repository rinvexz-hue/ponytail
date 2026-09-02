import type { Intent, Signal } from "../types.js";
import { nextIntentId, type Strategy, type StrategyContext } from "./Strategy.js";

/**
 * Deliberately simple example strategy: buy a fixed-size starter position
 * on a freshly observed pair that already clears a minimum liquidity and
 * volume bar. This is a template to replace, not a strategy anyone should
 * run with real money as-is — it has no edge, it's here to prove the
 * signal -> intent -> risk -> execution pipeline end to end.
 */
export class NewPairMomentumStrategy implements Strategy {
  readonly id = "new-pair-momentum-v0";

  constructor(
    private readonly minLiquidityUsd = 5_000,
    private readonly minVolume24hUsd = 10_000,
  ) {}

  decide(signal: Signal, context: StrategyContext): Intent | null {
    if (signal.kind !== "NEW_PAIR") return null;

    const liquidityUsd = Number(signal.payload.liquidityUsd ?? 0);
    const volume24hUsd = Number(signal.payload.volume24hUsd ?? 0);
    if (liquidityUsd < this.minLiquidityUsd || volume24hUsd < this.minVolume24hUsd) return null;

    const alreadyOpen = context.openPositions.some((p) => p.mint === signal.mint);
    if (alreadyOpen) return null;

    return {
      id: nextIntentId(),
      strategyId: this.id,
      signalId: signal.id,
      token: signal.token,
      mint: signal.mint,
      side: "BUY",
      sizeUsd: context.caps.maxUsdPerPosition,
      maxSlippageBps: context.caps.maxSlippageBps,
      reasoning:
        `New pair ${signal.token} clears liquidity ($${liquidityUsd.toFixed(0)}) and ` +
        `24h volume ($${volume24hUsd.toFixed(0)}) thresholds.`,
      createdAt: context.now,
    };
  }
}
