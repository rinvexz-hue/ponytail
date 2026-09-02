import { ComputeBudgetProgram, PublicKey, SystemProgram } from "@solana/web3.js";

/**
 * Program IDs the signer is willing to sign instructions for. Anything
 * outside this list is rejected before the transaction is ever signed —
 * this is what stops a compromised or buggy strategy/execution process
 * from smuggling in a "transfer everything to attacker wallet" or
 * "set a new authority" instruction disguised as a swap.
 *
 * These five are the stable, unambiguous system/SPL program IDs that do
 * not change across Jupiter versions or deployments.
 */
export const CORE_ALLOWED_PROGRAM_IDS: ReadonlySet<string> = new Set([
  SystemProgram.programId.toBase58(),
  ComputeBudgetProgram.programId.toBase58(),
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // SPL Token program
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // SPL Token-2022 program
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // Associated Token Account program
]);

/**
 * The DEX aggregator program ID (Jupiter, or whatever you route through)
 * is deliberately NOT hardcoded here. It has changed across major Jupiter
 * versions (v4 -> v6) and this codebase has no way to verify it against a
 * live source at build time — a wrong hardcoded value here would either
 * silently break every swap (fail-safe, annoying) or, worse, be trusted
 * without anyone checking it. Instead the operator must read it off
 * https://docs.jup.ag (or their aggregator's docs) themselves and pass it
 * in explicitly. See server.ts, which requires SWARMEXEC_JUPITER_PROGRAM_ID
 * and refuses to boot without it.
 *
 * Throws if `extraProgramIds` contains anything that isn't a syntactically
 * valid base58-encoded 32-byte public key — fail loud at boot, not silently
 * at sign time.
 */
export function buildAllowlist(extraProgramIds: readonly string[]): ReadonlySet<string> {
  const set = new Set(CORE_ALLOWED_PROGRAM_IDS);
  for (const id of extraProgramIds) {
    new PublicKey(id); // throws "Invalid public key input" if malformed
    set.add(id);
  }
  return set;
}
