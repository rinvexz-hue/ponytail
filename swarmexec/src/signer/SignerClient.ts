/**
 * Client the execution layer uses to talk to the isolated signer process.
 * This is the ONLY interface the execution/strategy process has to the
 * key — it sends an unsigned transaction and gets back a signature or a
 * signed transaction. It never sees, loads, or could reconstruct the key.
 */
export class SignerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly authToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async signAndSubmit(transactionBase64: string): Promise<{ signature: string }> {
    const res = await this.fetchImpl(`${this.baseUrl}/sign`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.authToken}` },
      body: JSON.stringify({ transactionBase64, submit: true }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Signer rejected transaction (${res.status}): ${body}`);
    }
    return (await res.json()) as { signature: string };
  }

  async health(): Promise<{ ok: boolean; pubkey: string }> {
    const res = await this.fetchImpl(`${this.baseUrl}/health`, {
      headers: { Authorization: `Bearer ${this.authToken}` },
    });
    return (await res.json()) as { ok: boolean; pubkey: string };
  }
}
