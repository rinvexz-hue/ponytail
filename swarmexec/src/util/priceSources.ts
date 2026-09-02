import type { PriceSource } from "../risk/gates/priceAgreementGate.js";

/** Price source backed by the public Dexscreener token-pairs endpoint. */
export class DexscreenerPriceSource implements PriceSource {
  readonly name = "dexscreener";

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async getUsdPrice(mint: string): Promise<number | null> {
    try {
      const res = await this.fetchImpl(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
      if (!res.ok) return null;
      const data = (await res.json()) as { pairs?: Array<{ priceUsd?: string }> };
      const first = data.pairs?.[0]?.priceUsd;
      return first ? Number(first) : null;
    } catch {
      return null;
    }
  }
}

/** Price source derived from a Jupiter quote (sell 1 unit worth ~$1 notional into SOL, then to USD via SOL price is overkill — Jupiter's price API is used directly here). */
export class JupiterPriceSource implements PriceSource {
  readonly name = "jupiter";

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async getUsdPrice(mint: string): Promise<number | null> {
    try {
      const res = await this.fetchImpl(`https://price.jup.ag/v6/price?ids=${mint}`);
      if (!res.ok) return null;
      const data = (await res.json()) as { data?: Record<string, { price?: number }> };
      const price = data.data?.[mint]?.price;
      return typeof price === "number" ? price : null;
    } catch {
      return null;
    }
  }
}
