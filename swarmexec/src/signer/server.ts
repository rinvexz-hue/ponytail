import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import { buildAllowlist } from "./allowlist.js";
import { describeTransaction, extractProgramIds } from "./extractProgramIds.js";

/**
 * Standalone signer process. This is the ONLY place in the whole system
 * that ever touches the private key. It intentionally:
 *   - binds to 127.0.0.1 only (never 0.0.0.0)
 *   - does not import strategy, signal, or execution code
 *   - makes no outbound network calls except submitting the exact signed
 *     transaction it was asked to sign
 *   - validates every instruction's program ID against a fixed allowlist
 *     before signing anything
 *
 * Run it as its own OS process (`npm run signer`), separate from the main
 * trading loop. The execution layer talks to it only over this HTTP API
 * and never has the key material in its own process memory.
 */

const PORT = Number(process.env.SWARMEXEC_SIGNER_PORT ?? 8787);
const HOST = "127.0.0.1";
const KEYPAIR_PATH = process.env.SWARMEXEC_SIGNER_KEYPAIR_PATH;
const AUTH_TOKEN = process.env.SWARMEXEC_SIGNER_TOKEN;
const RPC_URL = process.env.SWARMEXEC_RPC_URL ?? "https://api.mainnet-beta.solana.com";

if (!KEYPAIR_PATH) {
  throw new Error(
    "SWARMEXEC_SIGNER_KEYPAIR_PATH is not set. Refusing to start signer without an explicit " +
      "keypair path — this process must never guess where the key lives.",
  );
}
if (!AUTH_TOKEN) {
  throw new Error(
    "SWARMEXEC_SIGNER_TOKEN is not set. Refusing to start an unauthenticated signer, even " +
      "though it only binds to localhost — defense in depth against other local processes.",
  );
}

const JUPITER_PROGRAM_ID = process.env.SWARMEXEC_JUPITER_PROGRAM_ID;
if (!JUPITER_PROGRAM_ID) {
  throw new Error(
    "SWARMEXEC_JUPITER_PROGRAM_ID is not set. This signer refuses to guess your DEX " +
      "aggregator's program ID — it has changed across major Jupiter versions (v4 -> v6) " +
      "and signing against a wrong or stale value is exactly the kind of mistake this " +
      "allowlist exists to catch. Read the current value off https://docs.jup.ag yourself " +
      "and set it explicitly.",
  );
}
const ALLOWED_PROGRAM_IDS = buildAllowlist([JUPITER_PROGRAM_ID]);

const secretKey = new Uint8Array(JSON.parse(readFileSync(KEYPAIR_PATH, "utf8")));
const keypair = Keypair.fromSecretKey(secretKey);
const connection = new Connection(RPC_URL, "confirmed");

console.log(`[signer] loaded keypair for ${keypair.publicKey.toBase58()}`);
console.log(`[signer] listening on http://${HOST}:${PORT} (localhost only)`);

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

async function handleSign(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let body: { transactionBase64?: string; submit?: boolean };
  try {
    body = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body." });
    return;
  }

  if (!body.transactionBase64) {
    sendJson(res, 400, { error: "Missing transactionBase64." });
    return;
  }

  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(Buffer.from(body.transactionBase64, "base64"));
  } catch {
    sendJson(res, 400, { error: "Could not deserialize transaction as VersionedTransaction." });
    return;
  }

  const programIds = await extractProgramIds(tx, connection);
  const disallowed = programIds.filter((id) => !ALLOWED_PROGRAM_IDS.has(id));
  if (disallowed.length > 0) {
    console.warn(`[signer] REJECTED tx touching disallowed program(s): ${disallowed.join(", ")}`);
    sendJson(res, 403, {
      error: "Transaction touches program(s) outside the signer allowlist.",
      disallowedProgramIds: disallowed,
    });
    return;
  }

  tx.sign([keypair]);
  const summary = describeTransaction(tx);
  console.log(`[signer] signed tx: ${JSON.stringify(summary)} programs=${programIds.join(",")}`);

  if (body.submit) {
    try {
      const signature = await connection.sendTransaction(tx, { maxRetries: 3 });
      sendJson(res, 200, { signature });
    } catch (err) {
      sendJson(res, 502, { error: `Submission failed: ${(err as Error).message}` });
    }
    return;
  }

  sendJson(res, 200, { signedTransactionBase64: Buffer.from(tx.serialize()).toString("base64") });
}

const server = createServer((req, res) => {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${AUTH_TOKEN}`) {
    sendJson(res, 401, { error: "Unauthorized." });
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, { ok: true, pubkey: keypair.publicKey.toBase58() });
    return;
  }

  if (req.method === "POST" && req.url === "/sign") {
    handleSign(req, res).catch((err) => sendJson(res, 500, { error: (err as Error).message }));
    return;
  }

  sendJson(res, 404, { error: "Not found." });
});

server.listen(PORT, HOST);
