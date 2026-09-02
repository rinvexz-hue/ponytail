import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RiskCapsConfig } from "../config/index.js";
import type { Mode } from "../types.js";

interface GraduationRecord {
  strategyId: string;
  firstPaperTradeAt: number | null;
  paperTradeCount: number;
}

/**
 * Tracks, per strategy, how much PAPER-mode history it has accumulated.
 * A strategy is not allowed into LIVE_CAPPED/LIVE until it has traded for
 * at least `graduationMinDays` and produced at least `graduationMinTrades`
 * paper fills. This is state on disk so graduation status survives
 * restarts and isn't something anyone has to remember by hand.
 */
export class GraduationTracker {
  private readonly filePath: string;
  private records: Record<string, GraduationRecord>;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "graduation", "graduation.json");
    this.records = this.load();
  }

  private load(): Record<string, GraduationRecord> {
    if (!existsSync(this.filePath)) return {};
    return JSON.parse(readFileSync(this.filePath, "utf8"));
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.records, null, 2));
  }

  /** Call once per PAPER-mode fill for the given strategy. */
  recordPaperTrade(strategyId: string, now: number = Date.now()): void {
    const existing = this.records[strategyId] ?? {
      strategyId,
      firstPaperTradeAt: null,
      paperTradeCount: 0,
    };
    existing.firstPaperTradeAt ??= now;
    existing.paperTradeCount += 1;
    this.records[strategyId] = existing;
    this.persist();
  }

  isGraduated(strategyId: string, caps: RiskCapsConfig, now: number = Date.now()): boolean {
    const record = this.records[strategyId];
    if (!record || record.firstPaperTradeAt === null) return false;
    const daysActive = (now - record.firstPaperTradeAt) / (24 * 60 * 60 * 1000);
    return (
      daysActive >= caps.graduationMinDays && record.paperTradeCount >= caps.graduationMinTrades
    );
  }

  /**
   * Whether the given mode requires graduation at all. PAPER and TESTNET
   * are always allowed — they're how a strategy earns graduation in the
   * first place.
   */
  requiresGraduation(mode: Mode): boolean {
    return mode === "LIVE_CAPPED" || mode === "LIVE";
  }

  status(strategyId: string): GraduationRecord {
    return (
      this.records[strategyId] ?? { strategyId, firstPaperTradeAt: null, paperTradeCount: 0 }
    );
  }
}
