import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const DEFAULT_APP_KEY = "k671hqjipp2sdpl";

async function main() {
  const env = await loadEnv();
  const config = getConfig(env);
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
  const runRoot = joinDropboxPath(config.testRoot, runId);
  const api = new DropboxE2EApi(config);

  console.log(`Vaultbox Dropbox E2E run: ${runId}`);
  console.log(`Dropbox test root: ${config.testRoot || "/"}`);
  console.log(`Dropbox run folder: ${runRoot}`);

  try {
    await runTest("refresh token creates an access token", async () => {
      const token = await api.getAccessToken();
      assert.equal(typeof token, "string");
      assert(token.length > 0);
    });

    await runTest("create disposable test folder", async () => {
      await api.ensureFolder(config.testRoot);
      await api.createFolder(runRoot);
      const metadata = await api.getMetadata(runRoot);
      assert.equal(metadata[".tag"], "folder");
    });

    let firstRev = "";
    let secondRev = "";
    const notePath = joinDropboxPath(runRoot, "notes/hello.md");

    await runTest("upload file and read metadata", async () => {
      await api.createFolder(joinDropboxPath(runRoot, "notes"));
      const uploaded = await api.upload(notePath, "hello from vaultbox\n");
      assert.equal(uploaded[".tag"], "file");
      assert.equal(uploaded.path_lower, notePath.toLowerCase());
      assert.equal(typeof uploaded.rev, "string");
      assert.equal(typeof uploaded.content_hash, "string");
      assert(uploaded.rev.length > 0);
      assert(uploaded.content_hash.length > 0);
      firstRev = uploaded.rev;
    });

    await runTest("list folder finds uploaded file", async () => {
      const entries = await api.listAll(runRoot);
      const file = entries.find((entry) => entry.path_lower === notePath.toLowerCase());
      assert(file, `Expected ${notePath} in Dropbox listing`);
      assert.equal(file[".tag"], "file");
      assert.equal(file.rev, firstRev);
    });

    await runTest("download uploaded file", async () => {
      const content = await api.download(notePath);
      assert.equal(content, "hello from vaultbox\n");
    });

    await runTest("guarded update succeeds with current rev", async () => {
      const uploaded = await api.upload(notePath, "updated from vaultbox\n", firstRev);
      assert.equal(uploaded[".tag"], "file");
      assert.notEqual(uploaded.rev, firstRev);
      secondRev = uploaded.rev;
      assert.equal(await api.download(notePath), "updated from vaultbox\n");
    });

    await runTest("guarded update fails with stale rev", async () => {
      await assert.rejects(
        () => api.upload(notePath, "stale update should fail\n", firstRev),
        /Dropbox \/files\/upload failed with 409/,
      );
      assert.equal(await api.download(notePath), "updated from vaultbox\n");
      const metadata = await api.getMetadata(notePath);
      assert.equal(metadata.rev, secondRev);
    });

    await runTest("delete uploaded file", async () => {
      const deleted = await api.delete(notePath);
      assert.equal(deleted.metadata[".tag"], "file");
      await assert.rejects(
        () => api.getMetadata(notePath),
        /Dropbox \/files\/get_metadata failed with 409/,
      );
    });

    console.log("Dropbox E2E passed.");
  } finally {
    if (config.keepArtifacts) {
      console.log(`Keeping Dropbox E2E folder ${runRoot}`);
    } else {
      await api.delete(runRoot).catch((error) => {
        console.warn(`Could not delete ${runRoot}: ${error.message}`);
      });
    }
  }
}

async function runTest(name, fn) {
  process.stdout.write(`- ${name}... `);
  await fn();
  process.stdout.write("ok\n");
}

async function loadEnv() {
  const explicit = process.env.VAULTBOX_E2E_ENV_FILE;
  const candidates = explicit
    ? [path.resolve(explicit)]
    : [path.join(repoRoot, ".env.e2e"), path.join(repoRoot, ".env")];
  const loaded = { ...process.env };

  for (const candidate of candidates) {
    try {
      const raw = await fs.readFile(candidate, "utf8");
      Object.assign(loaded, parseEnv(raw));
      loaded.VAULTBOX_E2E_ENV_FILE = candidate;
      return loaded;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  throw new Error(
    [
      "Missing E2E environment file.",
      "",
      "To run Dropbox E2E tests:",
      "  1. Copy env.e2e.sample to .env.e2e",
      "  2. Fill in VAULTBOX_E2E_DROPBOX_REFRESH_TOKEN",
      "  3. Optionally set VAULTBOX_E2E_DROPBOX_TEST_ROOT to a disposable Dropbox folder",
      "  4. Run npm run test:e2e",
      "",
      "You can also set VAULTBOX_E2E_ENV_FILE=/path/to/envfile if you keep secrets elsewhere.",
    ].join("\n"),
  );
}

function parseEnv(raw) {
  const values = {};

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }

  return values;
}

function getConfig(env) {
  const refreshToken = env.VAULTBOX_E2E_DROPBOX_REFRESH_TOKEN;

  if (!refreshToken) {
    throw new Error(
      [
        "Missing E2E env value: VAULTBOX_E2E_DROPBOX_REFRESH_TOKEN",
        "",
        "Create .env.e2e from env.e2e.sample and add a Dropbox refresh token for a throwaway account or folder.",
      ].join("\n"),
    );
  }

  return {
    appKey: env.VAULTBOX_E2E_DROPBOX_APP_KEY || DEFAULT_APP_KEY,
    refreshToken,
    testRoot: normalizeDropboxPath(env.VAULTBOX_E2E_DROPBOX_TEST_ROOT || "/Vaultbox E2E"),
    keepArtifacts: env.VAULTBOX_E2E_KEEP_ARTIFACTS === "true",
  };
}

function normalizeDropboxPath(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || trimmed === "/") {
    return "";
  }
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

function joinDropboxPath(...parts) {
  return normalizeDropboxPath(parts.filter(Boolean).join("/"));
}

class DropboxE2EApi {
  constructor(config) {
    this.config = config;
    this.accessToken = "";
    this.accessTokenExpiresAt = 0;
  }

  async getAccessToken() {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt) {
      return this.accessToken;
    }

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.config.refreshToken,
      client_id: this.config.appKey,
    });
    const response = await fetch("https://api.dropboxapi.com/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    if (!response.ok) {
      throw new Error(`Dropbox OAuth refresh failed with ${response.status}: ${await response.text()}`);
    }

    const json = await response.json();
    this.accessToken = json.access_token;
    this.accessTokenExpiresAt = Date.now() + Math.max(0, (json.expires_in ?? 14_400) - 60) * 1000;
    return this.accessToken;
  }

  async createFolder(path) {
    const response = await this.rpc("/files/create_folder_v2", {
      path,
      autorename: false,
    }, { allowConflict: true });

    return response;
  }

  async ensureFolder(path) {
    if (!path) {
      return;
    }

    const parts = path.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = joinDropboxPath(current, part);
      await this.createFolder(current);
    }
  }

  async listAll(path) {
    const entries = [];
    let result = await this.rpc("/files/list_folder", {
      path,
      recursive: true,
      include_deleted: false,
      include_mounted_folders: true,
      include_non_downloadable_files: false,
    });
    entries.push(...result.entries);

    while (result.has_more) {
      result = await this.rpc("/files/list_folder/continue", {
        cursor: result.cursor,
      });
      entries.push(...result.entries);
    }

    return entries;
  }

  async getMetadata(path) {
    return this.rpc("/files/get_metadata", {
      path,
      include_deleted: false,
      include_media_info: false,
    });
  }

  async upload(path, content, rev) {
    const mode = rev ? { ".tag": "update", update: rev } : { ".tag": "add" };
    return this.content("/files/upload", {
      path,
      mode,
      autorename: false,
      mute: false,
      strict_conflict: true,
    }, Buffer.from(content, "utf8"));
  }

  async download(path) {
    const response = await this.rawContent("/files/download", { path });
    return response.text();
  }

  async delete(path) {
    return this.rpc("/files/delete_v2", { path });
  }

  async rpc(endpoint, body, options = {}) {
    const response = await fetch(`https://api.dropboxapi.com/2${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await this.getAccessToken()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      if (options.allowConflict && response.status === 409 && text.includes("conflict")) {
        return null;
      }
      throw new Error(`Dropbox ${endpoint} failed with ${response.status}: ${text}`);
    }

    return response.json();
  }

  async content(endpoint, args, body) {
    const response = await this.rawContent(endpoint, args, body);
    return response.json();
  }

  async rawContent(endpoint, args, body) {
    const response = await fetch(`https://content.dropboxapi.com/2${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await this.getAccessToken()}`,
        "Content-Type": body ? "application/octet-stream" : "",
        "Dropbox-API-Arg": JSON.stringify(args),
      },
      body,
    });

    if (!response.ok) {
      throw new Error(`Dropbox ${endpoint} failed with ${response.status}: ${await response.text()}`);
    }

    return response;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
