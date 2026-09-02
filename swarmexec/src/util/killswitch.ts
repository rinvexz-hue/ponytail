import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type KillSwitchAction = "HALT" | "HALT_AND_EXIT";

/**
 * A file-flag kill switch. Deliberately dumb: any process on the machine —
 * including a human with a text editor, or the CLI in killswitchCli.ts —
 * can trip it by writing a file, and the main loop polls for it every
 * tick. This means the kill switch works even if the main process is
 * wedged in a bad loop, deadlocked, or otherwise unresponsive to in-process
 * signals.
 */
export class KillSwitch {
  constructor(private readonly flagPath: string) {}

  trip(action: KillSwitchAction, triggeredBy: string): void {
    mkdirSync(dirname(this.flagPath), { recursive: true });
    writeFileSync(this.flagPath, JSON.stringify({ action, triggeredBy, at: Date.now() }, null, 2));
  }

  reset(): void {
    if (existsSync(this.flagPath)) {
      unlinkSync(this.flagPath);
    }
  }

  isActive(): boolean {
    return existsSync(this.flagPath);
  }

  read(): { action: KillSwitchAction; triggeredBy: string; at: number } | null {
    if (!this.isActive()) return null;
    return JSON.parse(readFileSync(this.flagPath, "utf8"));
  }
}
