import { afterEach, describe, expect, it } from "vitest";
import { assertModeBootAllowed, LIVE_CONFIRMATION_PHRASE, loadConfig } from "../src/config/index.js";

describe("mode boot gating", () => {
  afterEach(() => {
    delete process.env.SWARMEXEC_CONFIRM;
    delete process.env.SWARMEXEC_MODE;
  });

  it("allows PAPER, TESTNET and LIVE_CAPPED without any confirmation", () => {
    expect(() => assertModeBootAllowed("PAPER")).not.toThrow();
    expect(() => assertModeBootAllowed("TESTNET")).not.toThrow();
    expect(() => assertModeBootAllowed("LIVE_CAPPED")).not.toThrow();
  });

  it("refuses to boot LIVE without the exact confirmation phrase", () => {
    delete process.env.SWARMEXEC_CONFIRM;
    expect(() => assertModeBootAllowed("LIVE")).toThrow(/Refusing to boot in LIVE mode/);

    process.env.SWARMEXEC_CONFIRM = "yes i am sure";
    expect(() => assertModeBootAllowed("LIVE")).toThrow();
  });

  it("boots LIVE only with the exact phrase", () => {
    process.env.SWARMEXEC_CONFIRM = LIVE_CONFIRMATION_PHRASE;
    expect(() => assertModeBootAllowed("LIVE")).not.toThrow();
  });

  it("defaults loadConfig() to PAPER when SWARMEXEC_MODE is unset", () => {
    delete process.env.SWARMEXEC_MODE;
    const config = loadConfig();
    expect(config.mode).toBe("PAPER");
  });

  it("rejects an invalid SWARMEXEC_MODE value", () => {
    process.env.SWARMEXEC_MODE = "YOLO";
    expect(() => loadConfig()).toThrow(/Invalid SWARMEXEC_MODE/);
  });
});
