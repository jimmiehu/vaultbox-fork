import { addIcon, Notice, Plugin } from "obsidian";
import {
  createDropboxAuthSession,
  exchangeDropboxAuthCode,
  refreshDropboxAccessToken,
} from "./dropbox-auth";
import { DropboxClient, normalizeDropboxPath } from "./dropbox";
import { VAULTBOX_ICON } from "./icons";
import { VaultboxSettingTab } from "./settings-tab";
import { DEFAULT_SETTINGS, type VaultboxSettings } from "./types";

interface VaultboxPluginData {
  settings?: Partial<VaultboxSettings>;
  pendingAuthCodeVerifier?: string;
}

export default class VaultboxPlugin extends Plugin {
  settings: VaultboxSettings = { ...DEFAULT_SETTINGS };
  pendingAuthCodeVerifier = "";

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
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(data?.settings ?? {}),
    };
    this.pendingAuthCodeVerifier = data?.pendingAuthCodeVerifier ?? "";
  }

  async saveSettings(): Promise<void> {
    await this.saveData({
      settings: this.settings,
      pendingAuthCodeVerifier: this.pendingAuthCodeVerifier,
    } satisfies VaultboxPluginData);
  }

  isConnected(): boolean {
    return Boolean(this.settings.refreshToken);
  }

  async startDropboxAuth(): Promise<void> {
    if (!this.settings.dropboxAppKey.trim()) {
      new Notice("Add a Dropbox app key first.");
      return;
    }

    const session = await createDropboxAuthSession(this.settings.dropboxAppKey.trim());
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
      appKey: this.settings.dropboxAppKey.trim(),
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
      appKey: this.settings.dropboxAppKey.trim(),
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
    new Notice("Vaultbox sync planning is scaffolded next: auth and Dropbox folder access are in place.");
  }
}
