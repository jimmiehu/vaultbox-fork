import { afterEach, describe, expect, it, vi } from "vitest";
import { setRequestUrlMock } from "./mocks/obsidian";
import {
  createCodeChallenge,
  createDropboxAuthSession,
  exchangeDropboxAuthCode,
  refreshDropboxAccessToken,
} from "../src/dropbox-auth";

describe("Dropbox OAuth helpers", () => {
  afterEach(() => {
    setRequestUrlMock(null);
  });

  it("builds a no-redirect PKCE auth URL with offline access", async () => {
    const session = await createDropboxAuthSession("app-key", {
      codeVerifier: "test-verifier",
      scopes: ["files.metadata.read", "files.content.write"],
    });
    const url = new URL(session.authUrl);

    expect(url.origin + url.pathname).toBe("https://www.dropbox.com/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe("app-key");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("token_access_type")).toBe("offline");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.has("redirect_uri")).toBe(false);
    expect(url.searchParams.get("scope")).toBe("files.metadata.read files.content.write");
    expect(session.codeVerifier).toBe("test-verifier");
  });

  it("creates the expected S256 code challenge", async () => {
    await expect(createCodeChallenge("test-verifier")).resolves.toBe(
      "JBbiqONGWPaAmwXk_8bT6UnlPfrn65D32eZlJS-zGG0",
    );
  });

  it("exchanges an auth code without using a client secret", async () => {
    const request = vi.fn(async () => ({
      status: 200,
      text: "",
      json: {
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 3600,
        token_type: "bearer",
      },
      headers: {},
    }));
    setRequestUrlMock(request);

    const result = await exchangeDropboxAuthCode({
      appKey: "app-key",
      code: " auth-code ",
      codeVerifier: "verifier",
      now: 1_000,
    });

    expect(result).toEqual({
      accessToken: "access",
      refreshToken: "refresh",
      accessTokenExpiresAt: 3_541_000,
    });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.dropboxapi.com/oauth2/token",
        method: "POST",
        body: "grant_type=authorization_code&code=auth-code&client_id=app-key&code_verifier=verifier",
      }),
    );
    const firstCall = request.mock.calls[0] as Array<{ body?: string }> | undefined;
    expect(firstCall).toBeDefined();
    expect(firstCall?.[0].body).not.toContain("client_secret");
  });

  it("refreshes access tokens with the stored refresh token", async () => {
    setRequestUrlMock(async () => ({
      status: 200,
      text: "",
      json: {
        access_token: "new-access",
        expires_in: 14400,
        token_type: "bearer",
      },
      headers: {},
    }));

    await expect(
      refreshDropboxAccessToken({
        appKey: "app-key",
        refreshToken: "refresh",
        now: 10_000,
      }),
    ).resolves.toEqual({
      accessToken: "new-access",
      accessTokenExpiresAt: 14_350_000,
    });
  });
});
