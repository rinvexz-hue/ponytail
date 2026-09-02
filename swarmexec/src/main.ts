import { Connection } from "@solana/web3.js";
import { loadConfig } from "./config/index.js";
import { RugCheckGate, LiveRugCheckDataSource } from "./risk/gates/rugCheckGate.js";
import { PriceAgreementGate } from "./risk/gates/priceAgreementGate.js";
import { GraduationTracker } from "./risk/graduation.js";
import { RiskEngine, RiskState, type HardGate } from "./risk/RiskEngine.js";
import { DexscreenerNewPairSource } from "./signals/DexscreenerNewPairSource.js";
import type { SignalSource } from "./signals/SignalSource.js";
import { NewPairMomentumStrategy } from "./strategy/NewPairMomentumStrategy.js";
import type { Strategy } from "./strategy/Strategy.js";
import { PositionManager } from "./position/PositionManager.js";
import { PaperExecutor } from "./execution/PaperExecutor.js";
import { LiveExecutor } from "./execution/LiveExecutor.js";
import type { Executor } from "./execution/Executor.js";
import { SignerClient } from "./signer/SignerClient.js";
import { DexscreenerPriceSource, JupiterPriceSource } from "./util/priceSources.js";
import { EventLogger } from "./util/logger.js";
import { SignalDeduper } from "./util/dedupe.js";
import { KillSwitch } from "./util/killswitch.js";
import type { Order } from "./types.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const POLL_INTERVAL_MS = Number(process.env.SWARMEXEC_POLL_INTERVAL_MS ?? 15_000);
const DEFAULT_STOP_LOSS_PCT = 25;
const DEFAULT_TAKE_PROFIT_PCT = 50;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new EventLogger(config.dataDir);
  await logger.log({ type: "MODE_BOOT", at: Date.now(), data: { mode: config.mode } });
  console.log(`[swarmexec] booting in ${config.mode} mode`);

  const killSwitch = new KillSwitch(config.killSwitchFlagPath);
  const deduper = new SignalDeduper(config.risk.signalDedupeWindowMs);
  const graduation = new GraduationTracker(config.dataDir);
  const riskState = new RiskState();

  const dexscreener = new DexscreenerPriceSource();
  const jupiterPrice = new JupiterPriceSource();
  const rpcConnection = new Connection(
    process.env.SWARMEXEC_RPC_URL ?? "https://api.mainnet-beta.solana.com",
    "confirmed",
  );

  const entryGates: HardGate[] = [
    new PriceAgreementGate([dexscreener, jupiterPrice], config.risk),
    new RugCheckGate(new LiveRugCheckDataSource(rpcConnection), config.risk),
  ];

  const riskEngine = new RiskEngine({
    caps: config.risk,
    mode: config.mode,
    killSwitch,
    deduper,
    graduation,
    state: riskState,
    entryGates,
  });

  const strategies: Strategy[] = [new NewPairMomentumStrategy()];
  const signalSources: SignalSource[] = [new DexscreenerNewPairSource()];
  const positionManager = new PositionManager();

  const executor: Executor =
    config.mode === "PAPER" || config.mode === "TESTNET"
      ? new PaperExecutor(dexscreener, config.mode)
      : new LiveExecutor(
          new SignerClient(config.signerServiceUrl, requireSignerToken()),
          config.mode,
          async () => {
            const price = await jupiterPrice.getUsdPrice(SOL_MINT);
            if (price === null) throw new Error("Could not fetch SOL/USD price for sizing.");
            return price;
          },
        );

  console.log(`[swarmexec] wired ${strategies.length} strategies, ${signalSources.length} signal sources`);
  console.log(`[swarmexec] kill switch flag: ${config.killSwitchFlagPath}`);

  let lastKillSwitchLoggedAt = 0;
  let handledExitAll = false;

  async function forceExitAllPositions(triggeredBy: string): Promise<void> {
    for (const position of positionManager.getOpenPositions()) {
      const order: Order = {
        id: `emergency_${position.mint}_${Date.now()}`,
        intentId: "kill-switch-exit",
        strategyId: position.strategyId,
        token: position.token,
        mint: position.mint,
        side: "SELL",
        sizeUsd: position.sizeUsd,
        maxSlippageBps: 500,
        isExit: true,
        createdAt: Date.now(),
      };
      try {
        const fill = await executor.execute(order);
        await logger.log({ type: "ORDER", at: Date.now(), data: order });
        await logger.log({ type: "FILL", at: Date.now(), data: fill });
        const closed = positionManager.closeFromFill(fill);
        if (closed) {
          riskState.recordRealizedPnl(closed.pnlUsd);
          await logger.log({
            type: "POSITION_CLOSED",
            at: Date.now(),
            data: { ...closed, exitPrice: closed.exitPrice, pnlUsd: closed.pnlUsd },
          });
        }
      } catch (err) {
        console.error(`[swarmexec] emergency exit failed for ${position.token}:`, err);
      }
    }
    console.log(`[swarmexec] kill switch HALT_AND_EXIT complete, triggered by ${triggeredBy}`);
  }

  async function tick(): Promise<void> {
    deduper.prune();

    if (killSwitch.isActive()) {
      const state = killSwitch.read();
      if (state && state.at !== lastKillSwitchLoggedAt) {
        lastKillSwitchLoggedAt = state.at;
        handledExitAll = false;
        await logger.log({
          type: "KILL_SWITCH",
          at: Date.now(),
          data: { action: state.action, triggeredBy: state.triggeredBy },
        });
        console.warn(`[swarmexec] KILL SWITCH ACTIVE: ${state.action} (by ${state.triggeredBy})`);
      }
      if (state?.action === "HALT_AND_EXIT" && !handledExitAll) {
        handledExitAll = true;
        await forceExitAllPositions(state.triggeredBy);
      }
      return; // no new signal processing while halted
    }

    riskState.setCapitalAtRisk(positionManager.totalCapitalAtRiskUsd());

    // 1. Pull fresh signals and let each strategy react.
    for (const source of signalSources) {
      let signals;
      try {
        signals = await source.poll();
      } catch (err) {
        console.error(`[swarmexec] signal source ${source.name} failed:`, err);
        continue;
      }
      for (const signal of signals) {
        await logger.log({ type: "SIGNAL", at: Date.now(), data: signal });
        for (const strategy of strategies) {
          const intent = strategy.decide(signal, {
            openPositions: positionManager.getOpenPositions(),
            caps: config.risk,
            now: Date.now(),
          });
          if (!intent) continue;
          await processIntent(intent);
        }
      }
    }

    // 2. Check open positions for stop-loss/take-profit exits.
    const openPositions = positionManager.getOpenPositions();
    if (openPositions.length > 0) {
      const prices = new Map<string, number>();
      await Promise.all(
        openPositions.map(async (p) => {
          const price = await dexscreener.getUsdPrice(p.mint);
          if (price !== null) prices.set(p.mint, price);
        }),
      );
      const exitIntents = positionManager.checkExits(prices);
      for (const intent of exitIntents) {
        await processIntent(intent);
      }
    }
  }

  async function processIntent(intent: import("./types.js").Intent): Promise<void> {
    await logger.log({ type: "INTENT", at: Date.now(), data: intent });
    const decision = await riskEngine.evaluate(intent);
    await logger.log({
      type: "RISK_DECISION",
      at: Date.now(),
      data: { ...decision, intentId: intent.id },
    });
    if (!decision.approved) {
      console.log(`[swarmexec] REJECTED ${intent.side} ${intent.token}: ${decision.reason} — ${decision.detail}`);
      return;
    }

    const order = decision.order;
    await logger.log({ type: "ORDER", at: Date.now(), data: order });

    let fill;
    try {
      fill = await executor.execute(order);
    } catch (err) {
      console.error(`[swarmexec] execution failed for ${order.token}:`, err);
      return;
    }
    await logger.log({ type: "FILL", at: Date.now(), data: fill });
    console.log(
      `[swarmexec] FILLED ${fill.side} ${fill.token} $${fill.sizeUsd.toFixed(2)} @ ${fill.price.toFixed(8)}`,
    );

    if (config.mode === "PAPER" || config.mode === "TESTNET") {
      graduation.recordPaperTrade(order.strategyId);
    }

    if (fill.side === "BUY") {
      const position = positionManager.openFromFill(
        fill,
        order.strategyId,
        DEFAULT_STOP_LOSS_PCT,
        DEFAULT_TAKE_PROFIT_PCT,
      );
      await logger.log({ type: "POSITION_OPENED", at: Date.now(), data: position });
    } else {
      const closed = positionManager.closeFromFill(fill);
      if (closed) {
        riskState.recordRealizedPnl(closed.pnlUsd);
        await logger.log({
          type: "POSITION_CLOSED",
          at: Date.now(),
          data: { ...closed, exitPrice: closed.exitPrice, pnlUsd: closed.pnlUsd },
        });
        if (riskState.circuitBreakerTripped(config.risk)) {
          await logger.log({
            type: "CIRCUIT_BREAKER_TRIPPED",
            at: Date.now(),
            data: { reason: "daily loss cap", dailyPnlUsd: riskState.dailyPnlUsd() },
          });
          console.warn(`[swarmexec] CIRCUIT BREAKER TRIPPED — new entries halted for the rest of the UTC day.`);
        }
      }
    }
  }

  let stopped = false;
  process.on("SIGINT", () => {
    console.log("\n[swarmexec] shutting down (SIGINT)...");
    stopped = true;
  });
  process.on("SIGTERM", () => {
    stopped = true;
  });

  while (!stopped) {
    const start = Date.now();
    try {
      await tick();
    } catch (err) {
      console.error("[swarmexec] tick failed:", err);
    }
    const elapsed = Date.now() - start;
    await sleep(Math.max(0, POLL_INTERVAL_MS - elapsed));
  }
}

function requireSignerToken(): string {
  const token = process.env.SWARMEXEC_SIGNER_TOKEN;
  if (!token) {
    throw new Error(
      "SWARMEXEC_SIGNER_TOKEN must be set to talk to the signer service in LIVE_CAPPED/LIVE mode.",
    );
  }
  return token;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error("[swarmexec] fatal:", err);
  process.exitCode = 1;
});
