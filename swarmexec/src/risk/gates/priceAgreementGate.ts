import type { RiskCapsConfig } from "../../config/index.js";
import type { Intent } from "../../types.js";
import type { HardGate } from "../RiskEngine.js";

export interface PriceSource {
  name: string;
  getUsdPrice(mint: string): Promise<number | null>;
}

/**
 * Cross-checks price across at least two independent sources before
 * sizing a position. Stale or spoofed data on a single source (a common
 * failure mode for thinly-traded meme coins) is caught here instead of
 * flowing straight into position sizing.
 */
export class PriceAgreementGate implements HardGate {
  readonly name = "price-agreement";

  constructor(
    private readonly sources: PriceSource[],
    private readonly caps: RiskCapsConfig,
  ) {
    if (sources.length < 2) {
      throw new Error("PriceAgreementGate requires at least two independent price sources.");
    }
  }

  async check(intent: Intent): Promise<{ pass: true } | { pass: false; detail: string }> {
    const results = await Promise.all(
      this.sources.map(async (s) => ({ name: s.name, price: await s.getUsdPrice(intent.mint) })),
    );
    const available = results.filter((r): r is { name: string; price: number } => r.price !== null);

    if (available.length < 2) {
      return {
        pass: false,
        detail: `Only ${available.length}/${this.sources.length} price sources returned data.`,
      };
    }

    const prices = available.map((r) => r.price);
    const max = Math.max(...prices);
    const min = Math.min(...prices);
    const disagreementPct = min === 0 ? Infinity : ((max - min) / min) * 100;

    if (disagreementPct > this.caps.maxPriceSourceDisagreementPct) {
      return {
        pass: false,
        detail:
          `Price sources disagree by ${disagreementPct.toFixed(2)}% ` +
          `(cap ${this.caps.maxPriceSourceDisagreementPct}%): ` +
          available.map((r) => `${r.name}=${r.price}`).join(", "),
      };
    }

    return { pass: true };
  }
}
