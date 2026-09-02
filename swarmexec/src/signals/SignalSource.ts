import type { Signal } from "../types.js";

/**
 * A signal source observes the world and emits normalized Signal events.
 * It never trades, never sizes positions, never touches the risk layer —
 * that separation is what keeps a bad scraper from ever becoming a bad
 * trade directly.
 */
export interface SignalSource {
  name: string;
  poll(): Promise<Signal[]>;
}
