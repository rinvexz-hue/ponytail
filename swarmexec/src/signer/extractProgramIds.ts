import { PublicKey, VersionedTransaction, type Connection } from "@solana/web3.js";

/**
 * Resolves every program ID a versioned transaction actually invokes,
 * including accounts pulled in via address lookup tables. This is the
 * input to the allowlist check in server.ts — get this wrong and the
 * allowlist is decorative.
 */
export async function extractProgramIds(
  tx: VersionedTransaction,
  connection: Connection,
): Promise<string[]> {
  const message = tx.message;
  const staticKeys = message.staticAccountKeys.map((k) => k.toBase58());

  let loadedWritable: string[] = [];
  let loadedReadonly: string[] = [];
  const lookups = message.addressTableLookups;
  if (lookups.length > 0) {
    for (const lookup of lookups) {
      const table = await connection.getAddressLookupTable(lookup.accountKey);
      const addresses = table.value?.state.addresses ?? [];
      loadedWritable.push(...lookup.writableIndexes.map((i) => addresses[i]!.toBase58()));
      loadedReadonly.push(...lookup.readonlyIndexes.map((i) => addresses[i]!.toBase58()));
    }
  }

  const allKeys = [...staticKeys, ...loadedWritable, ...loadedReadonly];
  const programIds = new Set<string>();
  for (const ix of message.compiledInstructions) {
    const key = allKeys[ix.programIdIndex];
    if (key) programIds.add(key);
  }
  return [...programIds];
}

/** Best-effort readable summary for the audit log — never trust this for security decisions. */
export function describeTransaction(tx: VersionedTransaction): { numInstructions: number; numSigners: number } {
  return {
    numInstructions: tx.message.compiledInstructions.length,
    numSigners: tx.message.header.numRequiredSignatures,
  };
}

export function isValidBase58PublicKey(value: string): boolean {
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}
