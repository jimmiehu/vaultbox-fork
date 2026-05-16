export interface VaultboxSettings {
  dropboxAppKey: string;
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  selectedFolderPath: string;
  syncMode: "manual" | "automatic";
  syncIntervalMinutes: number;
  syncOnStartup: boolean;
  confirmBeforeManualSync: boolean;
  localChangeIndicatorEnabled: boolean;
  remoteChangeIndicatorEnabled: boolean;
  remoteChangeCheckIntervalMinutes: number;
}

export const DEFAULT_SETTINGS: VaultboxSettings = {
  dropboxAppKey: "k671hqjipp2sdpl",
  accessToken: "",
  accessTokenExpiresAt: 0,
  refreshToken: "",
  selectedFolderPath: "",
  syncMode: "manual",
  syncIntervalMinutes: 15,
  syncOnStartup: false,
  confirmBeforeManualSync: true,
  localChangeIndicatorEnabled: true,
  remoteChangeIndicatorEnabled: false,
  remoteChangeCheckIntervalMinutes: 15,
};

export interface DropboxAuthSession {
  codeVerifier: string;
  authUrl: string;
}

export interface DropboxTokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type: string;
  account_id?: string;
  uid?: string;
}

export interface DropboxFileMetadata {
  tag: "file";
  name: string;
  pathDisplay: string;
  pathLower: string;
  id: string;
  clientModified: string;
  serverModified: string;
  rev: string;
  size: number;
  contentHash: string;
}

export interface DropboxFolderMetadata {
  tag: "folder";
  name: string;
  pathDisplay: string;
  pathLower: string;
  id: string;
}

export type DropboxMetadata = DropboxFileMetadata | DropboxFolderMetadata;

export interface DropboxListResult {
  entries: DropboxMetadata[];
  cursor: string;
  hasMore: boolean;
}

export interface SyncedFileState {
  path: string;
  pathLower: string;
  localContentHash: string;
  remoteContentHash: string;
  remoteRev: string;
}

export interface VaultboxSyncState {
  files: Record<string, SyncedFileState>;
  lastSyncedAt: number;
}
