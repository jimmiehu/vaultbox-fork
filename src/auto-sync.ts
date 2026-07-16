import type { VaultboxSettings } from "./types";

export type SyncTrigger = "manual" | "startup" | "interval";

export type PlanDisposition = "apply" | "confirm" | "notify";

export type AutoSyncSettings = Pick<VaultboxSettings, "syncMode" | "syncIntervalMinutes" | "syncOnStartup">;

export function getAutoSyncIntervalMs(settings: AutoSyncSettings): number | null {
  if (settings.syncMode !== "automatic") {
    return null;
  }

  const minutes = settings.syncIntervalMinutes;
  if (!Number.isFinite(minutes) || minutes < 1) {
    return null;
  }

  return Math.round(minutes) * 60_000;
}

export function shouldSyncOnStartup(settings: AutoSyncSettings): boolean {
  return settings.syncMode === "automatic" && settings.syncOnStartup;
}

export function getPlanDisposition(trigger: SyncTrigger, confirmBeforeSync: boolean): PlanDisposition {
  if (!confirmBeforeSync) {
    return "apply";
  }

  return trigger === "manual" ? "confirm" : "notify";
}

export class SyncLock {
  private held = false;

  isHeld(): boolean {
    return this.held;
  }

  async runExclusive(run: () => Promise<void>): Promise<boolean> {
    if (this.held) {
      return false;
    }

    this.held = true;
    try {
      await run();
      return true;
    } finally {
      this.held = false;
    }
  }
}

export interface AutoSyncSchedulerDeps {
  runSync: (trigger: SyncTrigger) => Promise<void>;
  setInterval: (handler: () => void, intervalMs: number) => number;
  clearInterval: (id: number) => void;
  onIntervalCreated?: (id: number) => void;
  onTickError: (error: unknown) => void;
}

export class AutoSyncScheduler {
  private intervalId: number | null = null;

  constructor(private readonly deps: AutoSyncSchedulerDeps) {}

  reconfigure(settings: AutoSyncSettings): void {
    this.stop();

    const intervalMs = getAutoSyncIntervalMs(settings);
    if (intervalMs === null) {
      return;
    }

    this.intervalId = this.deps.setInterval(() => {
      void this.deps.runSync("interval").catch(this.deps.onTickError);
    }, intervalMs);
    this.deps.onIntervalCreated?.(this.intervalId);
  }

  stop(): void {
    if (this.intervalId !== null) {
      this.deps.clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}
