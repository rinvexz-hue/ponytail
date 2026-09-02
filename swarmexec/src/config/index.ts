import type { Mode } from "../types.js";

/**
 * Every cap here is a hard ceiling enforced by the risk layer (src/risk).
 * Strategies cannot see or influence this module — only the risk layer
 * imports it. Changing these numbers is the only sanctioned way to change
 * how much money the system can lose.
 */
export interface RiskCapsConfig {
  maxUsdPerPosition: number;
  maxTotalCapitalAtRiskUsd: number;
  maxTradesPerHour: number;
  maxDailyLossUsd: number;
  maxSlippageBps: number;
  /** Minimum PAPER-mode trading history a strategy needs before LIVE_CAPPED. */
  graduationMinDays: number;
  graduationMinTrades: number;
  /** Positions above this concentration among top holders are hard-rejected. */
  maxTopHolderConcentrationPct: number;
  /** Max acceptable disagreement between two independent price sources. */
  maxPriceSourceDisagreementPct: number;
  /** Signals for the same token within this window are deduped. */
  signalDedupeWindowMs: number;
}

export const DEFAULT_RISK_CAPS: RiskCapsConfig = {
  maxUsdPerPosition: 50,
  maxTotalCapitalAtRiskUsd: 250,
  maxTradesPerHour: 6,
  maxDailyLossUsd: 100,
  maxSlippageBps: 150, // 1.5%
  graduationMinDays: 7,
  graduationMinTrades: 30,
  maxTopHolderConcentrationPct: 40,
  maxPriceSourceDisagreementPct: 3,
  signalDedupeWindowMs: 5 * 60 * 1000,
};

const LIVE_CONFIRMATION_PHRASE = "I ACCEPT REAL FINANCIAL LOSS";

export interface SwarmConfig {
  mode: Mode;
  risk: RiskCapsConfig;
  dataDir: string;
  killSwitchFlagPath: string;
  signerServiceUrl: string;
}

function readMode(): Mode {
  const raw = (process.env.SWARMEXEC_MODE ?? "PAPER").toUpperCase();
  if (raw !== "PAPER" && raw !== "TESTNET" && raw !== "LIVE_CAPPED" && raw !== "LIVE") {
    throw new Error(
      `Invalid SWARMEXEC_MODE "${raw}". Must be one of PAPER, TESTNET, LIVE_CAPPED, LIVE.`,
    );
  }
  return raw;
}

/**
 * Refuses to boot into LIVE mode unless the operator has explicitly typed
 * the confirmation phrase into SWARMEXEC_CONFIRM. This is deliberately
 * annoying — it exists to stop a misconfigured env var (e.g. a copy-pasted
 * .env from a deploy template) from silently trading real money.
 *
 * LIVE_CAPPED does NOT require this: it is "real money, but hard-capped",
 * intended as the normal graduation step. Only unrestricted LIVE requires
 * the explicit ritual.
 */
export function assertModeBootAllowed(mode: Mode): void {
  if (mode !== "LIVE") return;
  const confirm = process.env.SWARMEXEC_CONFIRM;
  if (confirm !== LIVE_CONFIRMATION_PHRASE) {
    throw new Error(
      "Refusing to boot in LIVE mode: set SWARMEXEC_CONFIRM to the exact phrase " +
        `"${LIVE_CONFIRMATION_PHRASE}" to acknowledge you are running unrestricted ` +
        "real-money trading. Use LIVE_CAPPED for capped real-money trading instead.",
    );
  }
}

export function loadConfig(overrides: Partial<SwarmConfig> = {}): SwarmConfig {
  const mode = overrides.mode ?? readMode();
  assertModeBootAllowed(mode);
  return {
    mode,
    risk: { ...DEFAULT_RISK_CAPS, ...overrides.risk },
    dataDir: overrides.dataDir ?? process.env.SWARMEXEC_DATA_DIR ?? "./data",
    killSwitchFlagPath:
      overrides.killSwitchFlagPath ?? process.env.SWARMEXEC_KILLSWITCH_PATH ?? "./data/KILL",
    signerServiceUrl:
      overrides.signerServiceUrl ?? process.env.SWARMEXEC_SIGNER_URL ?? "http://127.0.0.1:8787",
  };
}

export { LIVE_CONFIRMATION_PHRASE };
