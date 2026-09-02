#!/usr/bin/env node
import { loadConfig } from "../config/index.js";
import { KillSwitch, type KillSwitchAction } from "./killswitch.js";

/**
 * Standalone CLI so the kill switch can be tripped from a separate
 * terminal/process regardless of what state the main trading loop is in.
 *
 * Usage:
 *   npm run killswitch -- halt              # stop new order submission
 *   npm run killswitch -- halt-and-exit      # also market-exit all open positions
 *   npm run killswitch -- reset              # clear the flag, resume trading
 *   npm run killswitch -- status
 */
function main(): void {
  const arg = process.argv[2];
  const config = loadConfig();
  const killSwitch = new KillSwitch(config.killSwitchFlagPath);

  switch (arg) {
    case "halt":
    case "halt-and-exit": {
      const action: KillSwitchAction = arg === "halt-and-exit" ? "HALT_AND_EXIT" : "HALT";
      killSwitch.trip(action, "cli");
      console.log(`Kill switch tripped: ${action}. Flag written to ${config.killSwitchFlagPath}`);
      break;
    }
    case "reset":
      killSwitch.reset();
      console.log("Kill switch reset. Trading may resume.");
      break;
    case "status": {
      const state = killSwitch.read();
      console.log(state ? `ACTIVE: ${JSON.stringify(state)}` : "INACTIVE");
      break;
    }
    default:
      console.error("Usage: npm run killswitch -- <halt|halt-and-exit|reset|status>");
      process.exitCode = 1;
  }
}

main();
