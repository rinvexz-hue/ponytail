/**
 * Prevents a bug (or a genuinely repeated real-world signal) from opening
 * N duplicate positions in the same token within a short window. This is
 * a hard gate in the risk layer, not something a strategy can opt out of.
 */
export class SignalDeduper {
  private readonly lastSeenAt = new Map<string, number>();

  constructor(private readonly windowMs: number) {}

  /** Returns true if this (mint, side) pair is a duplicate within the window. */
  isDuplicate(mint: string, side: string, now: number = Date.now()): boolean {
    const key = `${mint}:${side}`;
    const last = this.lastSeenAt.get(key);
    if (last !== undefined && now - last < this.windowMs) {
      return true;
    }
    return false;
  }

  /** Records that (mint, side) was just accepted, starting a fresh window. */
  record(mint: string, side: string, now: number = Date.now()): void {
    this.lastSeenAt.set(`${mint}:${side}`, now);
  }

  /** Drops entries older than the window so the map doesn't grow unbounded. */
  prune(now: number = Date.now()): void {
    for (const [key, ts] of this.lastSeenAt) {
      if (now - ts >= this.windowMs) {
        this.lastSeenAt.delete(key);
      }
    }
  }
}
