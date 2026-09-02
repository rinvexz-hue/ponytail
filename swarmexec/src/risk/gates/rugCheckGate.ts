import { PublicKey, type Connection } from "@solana/web3.js";
import type { RiskCapsConfig } from "../../config/index.js";
import type { Intent } from "../../types.js";
import type { HardGate } from "../RiskEngine.js";

export interface MintAuthorityInfo {
  mintAuthority: string | null;
  freezeAuthority: string | null;
}

export interface HolderConcentration {
  topHoldersPct: number;
}

/**
 * Everything this gate needs from the outside world, expressed as small
 * interfaces instead of a hard dependency on live RPC/HTTP calls. This is
 * what makes the gate unit-testable without a real Solana connection, and
 * what lets main.ts swap in real implementations at boot.
 */
export interface RugCheckDataSource {
  getMintAuthorities(mint: string): Promise<MintAuthorityInfo>;
  getHolderConcentration(mint: string): Promise<HolderConcentration>;
  /** Is the LP for this pair known-locked/burned? `null` = unknown. */
  isLiquidityLocked(mint: string): Promise<boolean | null>;
  /** Can the token actually be sold right now (simulated sell quote succeeds)? */
  canSimulateSell(mint: string, notionalUsd: number): Promise<boolean>;
}

/**
 * Hard rug-pull gate. Every check here can only REJECT — there is no
 * scoring system a strategy can override. Unknown liquidity-lock status is
 * treated as a rejection, not a pass, because "unknown" is exactly the
 * state a rug pull looks like right before it happens.
 */
export class RugCheckGate implements HardGate {
  readonly name = "rug-check";

  constructor(
    private readonly dataSource: RugCheckDataSource,
    private readonly caps: RiskCapsConfig,
  ) {}

  async check(intent: Intent): Promise<{ pass: true } | { pass: false; detail: string }> {
    const authorities = await this.dataSource.getMintAuthorities(intent.mint);
    if (authorities.mintAuthority !== null) {
      return {
        pass: false,
        detail: `Mint authority not renounced (${authorities.mintAuthority}); supply can be inflated.`,
      };
    }
    if (authorities.freezeAuthority !== null) {
      return {
        pass: false,
        detail: `Freeze authority not renounced (${authorities.freezeAuthority}); accounts can be frozen.`,
      };
    }

    const locked = await this.dataSource.isLiquidityLocked(intent.mint);
    if (locked !== true) {
      return {
        pass: false,
        detail: `Liquidity lock status is ${locked === null ? "unknown" : "not locked"}; treated as reject.`,
      };
    }

    const concentration = await this.dataSource.getHolderConcentration(intent.mint);
    if (concentration.topHoldersPct > this.caps.maxTopHolderConcentrationPct) {
      return {
        pass: false,
        detail:
          `Top-10 holder concentration ${concentration.topHoldersPct.toFixed(1)}% exceeds ` +
          `cap ${this.caps.maxTopHolderConcentrationPct}%.`,
      };
    }

    const canSell = await this.dataSource.canSimulateSell(intent.mint, intent.sizeUsd);
    if (!canSell) {
      return { pass: false, detail: "Simulated sell quote failed — likely honeypot / no sell route." };
    }

    return { pass: true };
  }
}

/**
 * Real implementation backed by a Solana RPC connection and the Jupiter
 * quote API. Kept separate from RugCheckGate itself so the gate's decision
 * logic stays pure and testable while this class owns the messy I/O.
 *
 * LP-lock detection is intentionally conservative: this default
 * implementation has no reliable general-purpose way to verify a lock
 * across every locker program, so it always returns `null` (unknown)
 * unless the mint is in `knownLockedMints`. Because RugCheckGate treats
 * `null` as a rejection, the safe default is "don't trade it" until you
 * wire in a real locker-program check or a curated allowlist.
 */
export class LiveRugCheckDataSource implements RugCheckDataSource {
  constructor(
    private readonly connection: Connection,
    private readonly jupiterQuoteUrl = "https://quote-api.jup.ag/v6/quote",
    private readonly knownLockedMints: ReadonlySet<string> = new Set(),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getMintAuthorities(mint: string): Promise<MintAuthorityInfo> {
    const info = await this.connection.getParsedAccountInfo(new PublicKey(mint));
    const parsed = (info.value?.data as { parsed?: { info?: Record<string, unknown> } } | undefined)
      ?.parsed?.info;
    return {
      mintAuthority: (parsed?.mintAuthority as string | null | undefined) ?? null,
      freezeAuthority: (parsed?.freezeAuthority as string | null | undefined) ?? null,
    };
  }

  async getHolderConcentration(mint: string): Promise<HolderConcentration> {
    const largest = await this.connection.getTokenLargestAccounts(new PublicKey(mint));
    const supplyInfo = await this.connection.getTokenSupply(new PublicKey(mint));
    const totalSupply = Number(supplyInfo.value.amount);
    if (totalSupply <= 0) return { topHoldersPct: 100 };
    const top10 = largest.value
      .slice(0, 10)
      .reduce((sum, acc) => sum + Number(acc.amount), 0);
    return { topHoldersPct: (top10 / totalSupply) * 100 };
  }

  async isLiquidityLocked(mint: string): Promise<boolean | null> {
    if (this.knownLockedMints.has(mint)) return true;
    return null;
  }

  async canSimulateSell(mint: string, notionalUsd: number): Promise<boolean> {
    const solMint = "So11111111111111111111111111111111111111112";
    const microUnits = Math.max(1, Math.round(notionalUsd * 1_000_000));
    const url =
      `${this.jupiterQuoteUrl}?inputMint=${mint}&outputMint=${solMint}` +
      `&amount=${microUnits}&slippageBps=500`;
    try {
      const res = await this.fetchImpl(url);
      if (!res.ok) return false;
      const data = (await res.json()) as { outAmount?: string };
      return Boolean(data.outAmount && Number(data.outAmount) > 0);
    } catch {
      return false;
    }
  }
}
