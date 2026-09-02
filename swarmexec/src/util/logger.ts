import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SwarmEvent } from "../types.js";

/**
 * Append-only JSONL audit log. This is the single source of truth for
 * everything the system did — every signal, decision, order and fill.
 * A dashboard, backtester, or incident review reads this file; nothing
 * here is ever rewritten or deleted in place.
 */
export class EventLogger {
  private readonly filePath: string;
  private ready: Promise<void>;

  constructor(dataDir: string, fileName = "events.jsonl") {
    this.filePath = join(dataDir, fileName);
    this.ready = mkdir(dirname(this.filePath), { recursive: true }).then(() => undefined);
  }

  async log(event: SwarmEvent): Promise<void> {
    await this.ready;
    await appendFile(this.filePath, JSON.stringify(event) + "\n", "utf8");
  }

  path(): string {
    return this.filePath;
  }
}
