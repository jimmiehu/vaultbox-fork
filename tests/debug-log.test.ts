import { describe, expect, it } from "vitest";
import { DebugLog } from "../src/debug-log";
import { DEFAULT_SETTINGS } from "../src/types";

describe("DebugLog", () => {
  it("does not store entries when debug logging is disabled", () => {
    const log = new DebugLog({ ...DEFAULT_SETTINGS, debugLogging: false }, async () => {});

    log.write("sync.start");

    expect(log.getEntries()).toEqual([]);
  });

  it("stores sanitized entries when debug logging is enabled", async () => {
    let saved: unknown[] = [];
    const log = new DebugLog({ ...DEFAULT_SETTINGS, debugLogging: true }, async (entries) => {
      saved = entries;
    });

    log.write("dropbox.request", {
      token: "secret",
      path: "/Vault",
    });

    expect(log.getEntries()).toHaveLength(1);
    expect(log.getEntries()[0]?.data).toEqual({
      token: "[redacted]",
      path: "/Vault",
    });
    expect(log.format()).toContain("dropbox.request");
    expect(saved).toEqual(log.getEntries());
  });

  it("loads only valid entries and clears persisted entries", async () => {
    let saved: unknown[] = [];
    const log = new DebugLog({ ...DEFAULT_SETTINGS, debugLogging: true }, async (entries) => {
      saved = entries;
    });

    log.load([{ nope: true }, { timestamp: "2026-01-01T00:00:00.000Z", message: "ok" }]);
    expect(log.getEntries()).toHaveLength(1);

    await log.clear();

    expect(log.getEntries()).toEqual([]);
    expect(saved).toEqual([]);
  });
});
