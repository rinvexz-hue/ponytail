import type { PriceSource } from "../risk/gates/priceAgreementGate.js";
import type { Fill, Mode, Order } from "../types.js";
import { nextFillId, type Executor } from "./Executor.js";

/**
 * Simulates a fill against a real, live price — no chain transaction is
 * ever built or submitted. This is the default executor (PAPER and
 * TESTNET modes) and what every strategy must prove itself against before
 * graduating to LIVE_CAPPED.
 *
 * The slippage/fee model is deliberately pessimistic (worse than a real
 * fill would typically be) so a strategy that only looks good in PAPER
 * mode because paper fills are too generous is caught here, not in
 * production with real money.
 */
export class PaperExecutor implements Executor {
  constructor(
    private readonly priceSource: PriceSource,
    private readonly mode: Extract<Mode, "PAPER" | "TESTNET">,
    private readonly typicalFeeBps = 30,
    private readonly rng: () => number = Math.random,
  ) {}

  async execute(order: Order): Promise<Fill> {
    const price = await this.priceSource.getUsdPrice(order.mint);
    if (price === null || price <= 0) {
      throw new Error(`PaperExecutor: no live price available for ${order.token} (${order.mint}).`);
    }

    // Simulate realistic-ish slippage: a random fraction of the max allowed,
    // biased toward the unfavorable side (buys fill slightly higher, sells
    // slightly lower), never exceeding the order's own slippage cap.
    const slippageBps = this.rng() * order.maxSlippageBps;
    const slippageMultiplier =
      order.side === "BUY" ? 1 + slippageBps / 10_000 : 1 - slippageBps / 10_000;
    const fillPrice = price * slippageMultiplier;
    const feeUsd = (order.sizeUsd * this.typicalFeeBps) / 10_000;

    const fill: Fill = {
      id: nextFillId(),
      orderId: order.id,
      token: order.token,
      mint: order.mint,
      side: order.side,
      sizeUsd: order.sizeUsd,
      price: fillPrice,
      feeUsd,
      slippageBps,
      mode: this.mode,
      filledAt: Date.now(),
    };
    return fill;
  }
}
