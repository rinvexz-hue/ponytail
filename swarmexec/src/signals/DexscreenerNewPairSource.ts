import type { Signal } from "../types.js";
import type { SignalSource } from "./SignalSource.js";

interface DexscreenerPair {
  baseToken: { address: string; symbol: string };
  pairCreatedAt?: number;
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
}

/**
 * Polls Dexscreener's public token-profiles/search endpoint for recently
 * created Solana pairs and emits a NEW_PAIR Signal for each one not seen
 * before. This is read-only market data — it never places an order.
 */
export class DexscreenerNewPairSource implements SignalSource {
  readonly name = "dexscreener-new-pair";
  private readonly seenPairs = new Set<string>();

  constructor(
    private readonly searchQuery = "solana",
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly maxAgeMs = 15 * 60 * 1000,
  ) {}

  async poll(): Promise<Signal[]> {
    const res = await this.fetchImpl(
      `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(this.searchQuery)}`,
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { pairs?: DexscreenerPair[] };
    const now = Date.now();
    const signals: Signal[] = [];

    for (const pair of data.pairs ?? []) {
      const mint = pair.baseToken?.address;
      if (!mint || this.seenPairs.has(mint)) continue;
      const createdAt = pair.pairCreatedAt ?? 0;
      if (createdAt === 0 || now - createdAt > this.maxAgeMs) continue;

      this.seenPairs.add(mint);
      signals.push({
        id: `sig_${mint}_${now}`,
        source: this.name,
        token: pair.baseToken.symbol,
        mint,
        kind: "NEW_PAIR",
        observedAt: now,
        payload: {
          priceUsd: pair.priceUsd ? Number(pair.priceUsd) : null,
          liquidityUsd: pair.liquidity?.usd ?? null,
          volume24hUsd: pair.volume?.h24 ?? null,
          pairAgeMs: now - createdAt,
        },
      });
    }
    return signals;
  }
}
