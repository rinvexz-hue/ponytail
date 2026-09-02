import type { SignerClient } from "../signer/SignerClient.js";
import type { Fill, Mode, Order } from "../types.js";
import { nextFillId, type Executor } from "./Executor.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";

interface JupiterQuoteResponse {
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
}

/**
 * Executes real swaps through Jupiter's aggregator, signed by the isolated
 * signer service — this process never holds the key. Only used in
 * LIVE_CAPPED and LIVE modes; every order it receives has already passed
 * every hard gate in the risk layer (this class does not re-check caps).
 */
export class LiveExecutor implements Executor {
  private cachedUserPubkey: string | null = null;

  constructor(
    private readonly signer: SignerClient,
    private readonly mode: Extract<Mode, "LIVE_CAPPED" | "LIVE">,
    private readonly solUsdPrice: () => Promise<number>,
    private readonly quoteUrl = "https://quote-api.jup.ag/v6/quote",
    private readonly swapUrl = "https://quote-api.jup.ag/v6/swap",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async userPubkey(): Promise<string> {
    this.cachedUserPubkey ??= (await this.signer.health()).pubkey;
    return this.cachedUserPubkey;
  }

  async execute(order: Order): Promise<Fill> {
    const solPrice = await this.solUsdPrice();
    const inputMint = order.side === "BUY" ? SOL_MINT : order.mint;
    const outputMint = order.side === "BUY" ? order.mint : SOL_MINT;
    const inputIsSol = order.side === "BUY";

    const amountLamportsOrUnits = inputIsSol
      ? Math.round((order.sizeUsd / solPrice) * 1e9)
      : // Selling: caller is expected to size `order.sizeUsd` from the
        // position's token quantity upstream; here we treat sizeUsd as the
        // USD notional and let Jupiter's quote determine token amount via
        // the position manager passing qty separately in a real integration.
        Math.round(order.sizeUsd * 1e6);

    const quoteRes = await this.fetchImpl(
      `${this.quoteUrl}?inputMint=${inputMint}&outputMint=${outputMint}` +
        `&amount=${amountLamportsOrUnits}&slippageBps=${order.maxSlippageBps}`,
    );
    if (!quoteRes.ok) {
      throw new Error(`Jupiter quote failed: ${quoteRes.status} ${await quoteRes.text()}`);
    }
    const quote = (await quoteRes.json()) as JupiterQuoteResponse;

    const userPublicKey = await this.userPubkey();
    const swapRes = await this.fetchImpl(this.swapUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
      }),
    });
    if (!swapRes.ok) {
      throw new Error(`Jupiter swap build failed: ${swapRes.status} ${await swapRes.text()}`);
    }
    const { swapTransaction } = (await swapRes.json()) as { swapTransaction: string };

    const { signature } = await this.signer.signAndSubmit(swapTransaction);

    const inAmount = Number(quote.inAmount);
    const outAmount = Number(quote.outAmount);
    const effectivePrice =
      order.side === "BUY"
        ? (inAmount / 1e9) * solPrice / (outAmount || 1)
        : (outAmount / 1e9) * solPrice / (inAmount || 1);

    const fill: Fill = {
      id: nextFillId(),
      orderId: order.id,
      token: order.token,
      mint: order.mint,
      side: order.side,
      sizeUsd: order.sizeUsd,
      price: effectivePrice,
      feeUsd: 0, // Jupiter fees are embedded in the quote's price impact, not a separate line item here.
      slippageBps: Math.abs(Number(quote.priceImpactPct)) * 100,
      mode: this.mode,
      txSignature: signature,
      filledAt: Date.now(),
    };
    return fill;
  }
}
