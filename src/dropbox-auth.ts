import { requestUrl } from "obsidian";
import type { DropboxAuthSession, DropboxTokenResponse } from "./types";

const DROPBOX_AUTHORIZE_URL = "https://www.dropbox.com/oauth2/authorize";
const DROPBOX_TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";

const DEFAULT_SCOPES = [
  "account_info.read",
  "files.metadata.read",
  "files.metadata.write",
  "files.content.read",
  "files.content.write",
];

export function createCodeVerifier(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export async function createCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

export async function createDropboxAuthSession(
  appKey: string,
  options: {
    scopes?: string[];
    codeVerifier?: string;
  } = {},
): Promise<DropboxAuthSession> {
  const codeVerifier = options.codeVerifier ?? createCodeVerifier();
  const codeChallenge = await createCodeChallenge(codeVerifier);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: appKey,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    token_access_type: "offline",
    scope: (options.scopes ?? DEFAULT_SCOPES).join(" "),
  });

  return {
    codeVerifier,
    authUrl: `${DROPBOX_AUTHORIZE_URL}?${params.toString()}`,
  };
}

export async function exchangeDropboxAuthCode(args: {
  appKey: string;
  code: string;
  codeVerifier: string;
  now?: number;
}): Promise<{
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
}> {
  const response = await postTokenRequest({
    grant_type: "authorization_code",
    code: args.code.trim(),
    client_id: args.appKey,
    code_verifier: args.codeVerifier,
  });

  if (!response.refresh_token) {
    throw new Error("Dropbox did not return a refresh token. Start auth again with offline access.");
  }

  return {
    accessToken: response.access_token,
    accessTokenExpiresAt: getExpiry(args.now ?? Date.now(), response.expires_in),
    refreshToken: response.refresh_token,
  };
}

export async function refreshDropboxAccessToken(args: {
  appKey: string;
  refreshToken: string;
  now?: number;
}): Promise<{
  accessToken: string;
  accessTokenExpiresAt: number;
}> {
  const response = await postTokenRequest({
    grant_type: "refresh_token",
    refresh_token: args.refreshToken,
    client_id: args.appKey,
  });

  return {
    accessToken: response.access_token,
    accessTokenExpiresAt: getExpiry(args.now ?? Date.now(), response.expires_in),
  };
}

function getExpiry(now: number, expiresInSeconds = 14_400): number {
  return now + Math.max(0, expiresInSeconds - 60) * 1000;
}

async function postTokenRequest(body: Record<string, string>): Promise<DropboxTokenResponse> {
  const response = await requestUrl({
    url: DROPBOX_TOKEN_URL,
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body).toString(),
    throw: false,
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Dropbox OAuth failed with ${response.status}: ${response.text}`);
  }

  return response.json as DropboxTokenResponse;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
