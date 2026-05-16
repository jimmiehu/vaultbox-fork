import { addIcon, Notice, Plugin } from "obsidian";
import {
  createDropboxAuthSession,
  exchangeDropboxAuthCode,
  refreshDropboxAccessToken,
} from "./dropbox-auth";
import { DROPBOX_APP_KEY } from "./constants";
import { DropboxClient, normalizeDropboxPath } from "./dropbox";
import { VAULTBOX_ICON } from "./icons";
import { VaultboxSettingTab } from "./settings-tab";
import { executeSyncPlan, SyncExecutionError } from "./sync-executor";
import {
  createRemoteFileSnapshot,
  createSyncPlan,
  formatSyncPlan,
  isPlanEmpty,
  scanLocalVault,
  type SyncPlan,
} from "./sync-plan";
import { DEFAULT_SETTINGS, type VaultboxSettings, type VaultboxSyncState } from "./types";

interface VaultboxPluginData {
  settings?: Partial<VaultboxSettings>;
  pendingAuthCodeVerifier?: string;
  syncState?: VaultboxSyncState;
}

export default class VaultboxPlugin extends Plugin {
  settings: VaultboxSettings = { ...DEFAULT_SETTINGS };
  pendingAuthCodeVerifier = "";
  syncState: VaultboxSyncState = { files: {}, lastSyncedAt: 0 };

  async onload(): Promise<void> {
    await this.loadSettings();

    addIcon("vaultbox-logo", VAULTBOX_ICON);
    this.addRibbonIcon("vaultbox-logo", "Sync with Vaultbox", () => {
      void this.syncNow();
    });

    this.addCommand({
      id: "connect-dropbox",
      name: "Connect Dropbox",
      callback: () => {
        void this.startDropboxAuth();
      },
    });

    this.addCommand({
      id: "validate-dropbox-folder",
      name: "Validate Dropbox folder",
      callback: () => {
        void this.validateSelectedFolder();
      },
    });

    this.addCommand({
      id: "sync-now",
      name: "Sync with Dropbox",
      callback: () => {
        void this.syncNow();
      },
    });

    this.addSettingTab(new VaultboxSettingTab(this.app, this));
  }

  async loadSettings(): Promise<void> {
    const data = await this.loadData() as VaultboxPluginData | null;
    const savedSettings = data?.settings as (Partial<VaultboxSettings> & { dropboxAppKey?: string }) | undefined;
    const { dropboxAppKey: _dropboxAppKey, ...settings } = savedSettings ?? {};
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...settings,
    };
    this.pendingAuthCodeVerifier = data?.pendingAuthCodeVerifier ?? "";
    this.syncState = data?.syncState ?? { files: {}, lastSyncedAt: 0 };
  }

  async saveSettings(): Promise<void> {
    await this.saveData({
      settings: this.settings,
      pendingAuthCodeVerifier: this.pendingAuthCodeVerifier,
      syncState: this.syncState,
    } satisfies VaultboxPluginData);
  }

  isConnected(): boolean {
    return Boolean(this.settings.refreshToken);
  }

  async startDropboxAuth(): Promise<void> {
    const session = await createDropboxAuthSession(DROPBOX_APP_KEY);
    this.pendingAuthCodeVerifier = session.codeVerifier;
    await this.saveSettings();
    window.open(session.authUrl);
    new Notice("Dropbox opened. Approve Vaultbox, then paste the authorization code here.");
  }

  async finishDropboxAuth(code: string): Promise<void> {
    if (!this.pendingAuthCodeVerifier) {
      throw new Error("Start Dropbox auth before entering a code.");
    }

    const tokens = await exchangeDropboxAuthCode({
      appKey: DROPBOX_APP_KEY,
      code,
      codeVerifier: this.pendingAuthCodeVerifier,
    });

    this.settings.accessToken = tokens.accessToken;
    this.settings.accessTokenExpiresAt = tokens.accessTokenExpiresAt;
    this.settings.refreshToken = tokens.refreshToken;
    this.pendingAuthCodeVerifier = "";
    await this.saveSettings();
    new Notice("Dropbox connected.");
  }

  async getAccessToken(): Promise<string> {
    if (!this.settings.refreshToken) {
      throw new Error("Dropbox is not connected.");
    }

    if (this.settings.accessToken && Date.now() < this.settings.accessTokenExpiresAt) {
      return this.settings.accessToken;
    }

    const refreshed = await refreshDropboxAccessToken({
      appKey: DROPBOX_APP_KEY,
      refreshToken: this.settings.refreshToken,
    });
    this.settings.accessToken = refreshed.accessToken;
    this.settings.accessTokenExpiresAt = refreshed.accessTokenExpiresAt;
    await this.saveSettings();
    return refreshed.accessToken;
  }

  createDropboxClient(): DropboxClient {
    return new DropboxClient({
      getAccessToken: () => this.getAccessToken(),
    });
  }

  async validateSelectedFolder(): Promise<void> {
    const folderPath = normalizeDropboxPath(this.settings.selectedFolderPath);
    this.settings.selectedFolderPath = folderPath;
    await this.saveSettings();

    if (!this.isConnected()) {
      new Notice("Connect Dropbox before validating a folder.");
      return;
    }

    const metadata = await this.createDropboxClient().getMetadata(folderPath);
    if (metadata.tag !== "folder") {
      throw new Error(`${folderPath || "/"} is not a Dropbox folder.`);
    }

    new Notice(`Vaultbox folder validated: ${metadata.pathDisplay || "/"}`);
  }

  async syncNow(): Promise<void> {
    try {
      const plan = await this.buildSyncPlan();
      if (plan.conflicts.length > 0) {
        new Notice(formatSyncPlan(plan, "Sync blocked"));
        return;
      }

      if (isPlanEmpty(plan)) {
        new Notice("No sync required. Everything is up to date.");
        return;
      }

      if (this.settings.syncMode === "manual" && this.settings.confirmBeforeManualSync) {
        const confirmed = window.confirm(`${formatSyncPlan(plan, "Confirm sync")}\n\nApply these changes now?`);
        if (!confirmed) {
          new Notice("Sync cancelled.");
          return;
        }
      }

      const result = await executeSyncPlan({
        vault: this.app.vault,
        dropbox: this.createDropboxClient(),
        rootPath: normalizeDropboxPath(this.settings.selectedFolderPath),
        plan,
        currentState: this.syncState,
      });
      this.syncState = result.state;
      await this.saveSettings();
      new Notice(`Sync complete. Applied ${result.applied} change${result.applied === 1 ? "" : "s"}.`);
    } catch (error) {
      if (error instanceof SyncExecutionError) {
        this.syncState = error.partialState;
        await this.saveSettings();
      }
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }

  async simulateSync(): Promise<string> {
    const plan = await this.buildSyncPlan();
    return formatSyncPlan(plan);
  }

  async buildSyncPlan(): Promise<SyncPlan> {
    if (!this.isConnected()) {
      throw new Error("Connect Dropbox before syncing.");
    }

    const folderPath = normalizeDropboxPath(this.settings.selectedFolderPath);
    this.settings.selectedFolderPath = folderPath;
    await this.saveSettings();

    const [localFiles, remoteFiles] = await Promise.all([
      scanLocalVault(this.app.vault),
      this.createDropboxClient().listAllFiles(folderPath),
    ]);

    return createSyncPlan({
      localFiles,
      remoteFiles: createRemoteFileSnapshot(remoteFiles, folderPath),
      state: this.syncState,
    });
  }
}
