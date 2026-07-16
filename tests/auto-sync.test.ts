import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AutoSyncScheduler,
  getAutoSyncIntervalMs,
  getPlanDisposition,
  shouldSyncOnStartup,
  SyncLock,
} from "../src/auto-sync";
import type { SyncPlan } from "../src/sync-plan";
import { DEFAULT_SETTINGS, type VaultboxSettings } from "../src/types";
import { Notice } from "./mocks/obsidian";

const executeSyncPlanMock = vi.hoisted(() => vi.fn());

vi.mock("../src/sync-executor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/sync-executor")>()),
  executeSyncPlan: executeSyncPlanMock,
}));

import VaultboxPlugin from "../src/main";

describe("sync lock", () => {
  it("skips a sync attempt while another sync holds the lock", async () => {
    const lock = new SyncLock();
    let release!: () => void;
    const first = lock.runExclusive(() => new Promise<void>((resolve) => {
      release = resolve;
    }));

    let overlapped = false;
    const second = await lock.runExclusive(async () => {
      overlapped = true;
    });

    expect(second).toBe(false);
    expect(overlapped).toBe(false);
    release();
    await expect(first).resolves.toBe(true);
    expect(lock.isHeld()).toBe(false);
  });

  it("releases the lock after a failed sync so the next sync can run", async () => {
    const lock = new SyncLock();
    await expect(lock.runExclusive(async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");

    expect(lock.isHeld()).toBe(false);
    await expect(lock.runExclusive(async () => {})).resolves.toBe(true);
  });
});

describe("auto sync schedule decisions", () => {
  it("computes the interval only for automatic mode with at least one minute", () => {
    expect(getAutoSyncIntervalMs(schedule("manual", 15))).toBe(null);
    expect(getAutoSyncIntervalMs(schedule("automatic", 0))).toBe(null);
    expect(getAutoSyncIntervalMs(schedule("automatic", 0.5))).toBe(null);
    expect(getAutoSyncIntervalMs(schedule("automatic", Number.NaN))).toBe(null);
    expect(getAutoSyncIntervalMs(schedule("automatic", 1))).toBe(60_000);
    expect(getAutoSyncIntervalMs(schedule("automatic", 15))).toBe(15 * 60_000);
  });

  it("syncs on startup only in automatic mode with the toggle on", () => {
    expect(shouldSyncOnStartup({ ...schedule("automatic", 15), syncOnStartup: true })).toBe(true);
    expect(shouldSyncOnStartup({ ...schedule("automatic", 15), syncOnStartup: false })).toBe(false);
    expect(shouldSyncOnStartup({ ...schedule("manual", 15), syncOnStartup: true })).toBe(false);
  });

  it("never applies an auto-triggered plan while confirm before sync is on", () => {
    expect(getPlanDisposition("interval", true)).toBe("notify");
    expect(getPlanDisposition("startup", true)).toBe("notify");
    expect(getPlanDisposition("manual", true)).toBe("confirm");
    expect(getPlanDisposition("interval", false)).toBe("apply");
    expect(getPlanDisposition("startup", false)).toBe("apply");
    expect(getPlanDisposition("manual", false)).toBe("apply");
  });
});

describe("auto sync scheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires interval ticks that no-op while a sync is already running", async () => {
    vi.useFakeTimers();
    const lock = new SyncLock();
    const started: string[] = [];
    let release!: () => void;
    const scheduler = new AutoSyncScheduler({
      runSync: async (trigger) => {
        await lock.runExclusive(() => {
          started.push(trigger);
          return new Promise<void>((resolve) => {
            release = resolve;
          });
        });
      },
      ...fakeTimerDeps(),
      onTickError: () => {},
    });

    scheduler.reconfigure({ ...schedule("automatic", 1), syncOnStartup: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(started).toEqual(["interval"]);

    await vi.advanceTimersByTimeAsync(180_000);
    expect(started).toEqual(["interval"]);

    release();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(started).toEqual(["interval", "interval"]);

    release();
    scheduler.stop();
  });

  it("clears the previous interval on reconfigure and stops in manual mode", async () => {
    vi.useFakeTimers();
    const runs: string[] = [];
    const scheduler = new AutoSyncScheduler({
      runSync: async () => {
        runs.push("tick");
      },
      ...fakeTimerDeps(),
      onTickError: () => {},
    });

    scheduler.reconfigure({ ...schedule("automatic", 1), syncOnStartup: false });
    scheduler.reconfigure({ ...schedule("automatic", 5), syncOnStartup: false });
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(runs).toEqual([]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(runs).toEqual(["tick"]);

    scheduler.reconfigure({ ...schedule("manual", 5), syncOnStartup: false });
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(runs).toEqual(["tick"]);
  });

  it("routes tick failures to the error handler instead of rejecting", async () => {
    vi.useFakeTimers();
    const errors: unknown[] = [];
    const scheduler = new AutoSyncScheduler({
      runSync: async () => {
        throw new Error("tick failed");
      },
      ...fakeTimerDeps(),
      onTickError: (error) => {
        errors.push(error);
      },
    });

    scheduler.reconfigure({ ...schedule("automatic", 1), syncOnStartup: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("tick failed");
    scheduler.stop();
  });
});

describe("auto sync confirm semantics", () => {
  beforeEach(() => {
    Notice.messages.length = 0;
    executeSyncPlanMock.mockReset();
    executeSyncPlanMock.mockResolvedValue({ applied: 1, state: { files: {}, lastSyncedAt: 1 } });
  });

  it("notifies instead of applying when confirm before sync is on", async () => {
    const plugin = createPlugin({ confirmBeforeManualSync: true });

    await plugin.runSync("interval");

    expect(executeSyncPlanMock).not.toHaveBeenCalled();
    expect(Notice.messages.some((message) => message.includes("1 change pending"))).toBe(true);
    expect(plugin.settings.lastSyncSummary).toContain("pending");
  });

  it("applies directly on auto triggers when confirm before sync is off", async () => {
    const plugin = createPlugin({ confirmBeforeManualSync: false });

    await plugin.runSync("startup");

    expect(executeSyncPlanMock).toHaveBeenCalledTimes(1);
    expect(plugin.settings.lastSyncSummary).toContain("Sync complete");
  });

  it("stays quiet on an empty plan for auto runs", async () => {
    const plugin = createPlugin({ confirmBeforeManualSync: false }, emptyPlan());

    await plugin.runSync("interval");

    expect(executeSyncPlanMock).not.toHaveBeenCalled();
    expect(Notice.messages).toEqual([]);
  });
});

function schedule(syncMode: VaultboxSettings["syncMode"], syncIntervalMinutes: number) {
  return { syncMode, syncIntervalMinutes, syncOnStartup: false };
}

function fakeTimerDeps() {
  const timers = new Map<number, ReturnType<typeof setInterval>>();
  let nextId = 1;
  return {
    setInterval: (handler: () => void, intervalMs: number): number => {
      const id = nextId;
      nextId += 1;
      timers.set(id, setInterval(handler, intervalMs));
      return id;
    },
    clearInterval: (id: number): void => {
      const timer = timers.get(id);
      if (timer !== undefined) {
        clearInterval(timer);
        timers.delete(id);
      }
    },
  };
}

function pendingPlan(): SyncPlan {
  return {
    operations: [
      {
        kind: "upload",
        path: "Notes/A.md",
        local: { path: "Notes/A.md", pathLower: "notes/a.md", contentHash: "hash", size: 1, mtime: 1 },
      },
    ],
    conflicts: [],
    summary: { uploads: 1, downloads: 0, remoteDeletes: 0, localDeletes: 0, noops: 0, conflicts: 0 },
  };
}

function emptyPlan(): SyncPlan {
  return {
    operations: [],
    conflicts: [],
    summary: { uploads: 0, downloads: 0, remoteDeletes: 0, localDeletes: 0, noops: 0, conflicts: 0 },
  };
}

function createPlugin(overrides: Partial<VaultboxSettings>, plan: SyncPlan = pendingPlan()): VaultboxPlugin {
  const plugin = Object.create(VaultboxPlugin.prototype) as VaultboxPlugin;
  Object.assign(plugin, {
    settings: {
      ...DEFAULT_SETTINGS,
      refreshToken: "refresh-token",
      selectedFolderPath: "/Vault",
      ...overrides,
    },
    syncState: { files: {}, lastSyncedAt: 0 },
    syncLock: new SyncLock(),
    debugLog: { write: () => {} },
    app: { vault: { configDir: ".obsidian" }, fileManager: {} },
  });
  plugin.saveSettings = async () => {};
  plugin.buildSyncPlan = async () => plan;
  return plugin;
}
