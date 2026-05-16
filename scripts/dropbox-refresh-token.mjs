import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const DEFAULT_APP_KEY = "k671hqjipp2sdpl";
const DEFAULT_TEST_ROOT = "/Vaultbox E2E";
const SCOPES = [
  "account_info.read",
  "files.metadata.read",
  "files.metadata.write",
  "files.content.read",
  "files.content.write",
];

const appKey = process.env.VAULTBOX_E2E_DROPBOX_APP_KEY || DEFAULT_APP_KEY;
const codeVerifier = base64UrlEncode(randomBytes(32));
const codeChallenge = base64UrlEncode(createHash("sha256").update(codeVerifier).digest());
const authUrl = new URL("https://www.dropbox.com/oauth2/authorize");

authUrl.search = new URLSearchParams({
  response_type: "code",
  client_id: appKey,
  code_challenge: codeChallenge,
  code_challenge_method: "S256",
  token_access_type: "offline",
  scope: SCOPES.join(" "),
}).toString();

console.log("Open this Dropbox authorization URL:");
console.log(authUrl.toString());
console.log("");
console.log("After approving access, Dropbox will show an authorization code.");
console.log("Paste that code here. The resulting refresh token will be written to .env.e2e.");
console.log("");

const rl = createInterface({ input, output });
const code = (await rl.question("Dropbox authorization code: ")).trim();
rl.close();

if (!code) {
  throw new Error("No authorization code supplied.");
}

const response = await fetch("https://api.dropboxapi.com/oauth2/token", {
  method: "POST",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
  },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: appKey,
    code_verifier: codeVerifier,
  }).toString(),
});

const tokenBody = await response.json().catch(async () => ({ error_description: await response.text() }));

if (!response.ok) {
  throw new Error(`Dropbox token exchange failed with ${response.status}: ${JSON.stringify(tokenBody)}`);
}

if (!tokenBody.refresh_token) {
  throw new Error("Dropbox did not return a refresh token.");
}

const envPath = ".env.e2e";
const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
const next = upsertEnvValue(
  upsertEnvValue(existing || `VAULTBOX_E2E_DROPBOX_TEST_ROOT=${DEFAULT_TEST_ROOT}\n`, "VAULTBOX_E2E_DROPBOX_REFRESH_TOKEN", tokenBody.refresh_token),
  "VAULTBOX_E2E_DROPBOX_APP_KEY",
  appKey,
);

writeFileSync(envPath, next.endsWith("\n") ? next : `${next}\n`);

console.log("");
console.log("Wrote Dropbox refresh token to .env.e2e.");
console.log("You can now run: npm run test:e2e");

function upsertEnvValue(contents, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^#?${escapeRegExp(key)}=.*$`, "m");

  if (pattern.test(contents)) {
    return contents.replace(pattern, line);
  }

  return `${contents.replace(/\s*$/, "\n")}${line}\n`;
}

function base64UrlEncode(bytes) {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
