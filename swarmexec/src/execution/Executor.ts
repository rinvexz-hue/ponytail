import type { Fill, Order } from "../types.js";

export interface Executor {
  execute(order: Order): Promise<Fill>;
}

let fillCounter = 0;
export function nextFillId(): string {
  fillCounter += 1;
  return `fill_${Date.now()}_${fillCounter}`;
}
