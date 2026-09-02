import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { buildAllowlist, CORE_ALLOWED_PROGRAM_IDS } from "../src/signer/allowlist.js";
import { extractProgramIds } from "../src/signer/extractProgramIds.js";

// extractProgramIds only touches `connection` when the tx uses address
// lookup tables; none of these test transactions do, so a stub is safe.
const fakeConnection = {} as Connection;

// Stand-in for a real aggregator program ID — any syntactically valid
// pubkey works here since these tests exercise the allowlist mechanism,
// not the specific value an operator must supply in production.
const FAKE_AGGREGATOR_PROGRAM_ID = Keypair.generate().publicKey.toBase58();

function buildTx(payer: Keypair, instructions: TransactionInstruction[]): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: "11111111111111111111111111111111111111111",
    instructions,
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

describe("signer allowlist", () => {
  it("allows a transaction that only touches System Program", async () => {
    const allowlist = buildAllowlist([FAKE_AGGREGATOR_PROGRAM_ID]);
    const payer = Keypair.generate();
    const recipient = Keypair.generate();
    const tx = buildTx(payer, [
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: recipient.publicKey,
        lamports: 1_000,
      }),
    ]);

    const programIds = await extractProgramIds(tx, fakeConnection);
    const disallowed = programIds.filter((id) => !allowlist.has(id));
    expect(disallowed).toEqual([]);
  });

  it("allows a transaction touching the configured aggregator program ID", async () => {
    const allowlist = buildAllowlist([FAKE_AGGREGATOR_PROGRAM_ID]);
    const payer = Keypair.generate();
    const tx = buildTx(payer, [
      new TransactionInstruction({
        programId: new PublicKey(FAKE_AGGREGATOR_PROGRAM_ID),
        keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }],
        data: Buffer.from([0]),
      }),
    ]);

    const programIds = await extractProgramIds(tx, fakeConnection);
    const disallowed = programIds.filter((id) => !allowlist.has(id));
    expect(disallowed).toEqual([]);
  });

  it("rejects a transaction touching a program outside the allowlist", async () => {
    const allowlist = buildAllowlist([FAKE_AGGREGATOR_PROGRAM_ID]);
    const payer = Keypair.generate();
    const suspiciousProgram = Keypair.generate().publicKey; // stand-in for an arbitrary/unknown program
    const tx = buildTx(payer, [
      new TransactionInstruction({
        programId: suspiciousProgram,
        keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }],
        data: Buffer.from([0]),
      }),
    ]);

    const programIds = await extractProgramIds(tx, fakeConnection);
    const disallowed = programIds.filter((id) => !allowlist.has(id));
    expect(disallowed).toEqual([suspiciousProgram.toBase58()]);
  });

  it("core allowlist contains only well-formed, non-empty program IDs", () => {
    expect(CORE_ALLOWED_PROGRAM_IDS.size).toBeGreaterThan(0);
    for (const id of CORE_ALLOWED_PROGRAM_IDS) {
      expect(() => new PublicKey(id)).not.toThrow();
    }
  });

  it("buildAllowlist rejects a malformed extra program ID at build time, not sign time", () => {
    expect(() => buildAllowlist(["not-a-real-base58-pubkey"])).toThrow();
  });
});
