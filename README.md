# Vaultbox

![Vaultbox logo](logo.png)

Vaultbox is an Obsidian plugin for syncing a vault directly with a selected Dropbox folder on desktop and mobile.

The goal is to support people who already keep an Obsidian vault in Dropbox on a desktop machine, but cannot use that same Dropbox folder from Obsidian mobile. Vaultbox will talk to the Dropbox API from inside Obsidian so phones and tablets can sync against the same Dropbox folder without relying on the Dropbox desktop client or local Git.

## Current Status

This repository is the first scaffold. It includes:

- Obsidian plugin build/test setup.
- Dropbox OAuth code flow with PKCE and offline refresh tokens.
- Dropbox folder picker for choosing an existing non-root vault folder.
- A starter Dropbox API client for listing, validating, uploading, downloading, and deleting files.
- A plan-first sync planner, simulation button, and debug log that compare local vault files with Dropbox without mutating either side.
- A guarded sync executor that applies conflict-free plans with local hash and Dropbox `rev` rechecks.
- Tests around auth, Dropbox API assumptions, and local/remote sync planning conflicts.

The executor is deliberately conservative: it detects conflicts before applying a plan, revalidates files before each write/delete, and stores partial progress if a later operation fails.

## Product Direction

Vaultbox will request Full Dropbox access because the core use case is syncing an existing vault folder that may already be managed by the Dropbox desktop app. The plugin should only operate inside the selected folder path and the README/settings UI should stay explicit about that permission tradeoff.

Planned behavior:

- Pick or enter an existing Dropbox folder.
- Sync manually or automatically.
- Simulate planned changes before applying them. Initial simulation support is in place.
- Detect local/remote conflicts and ask for a decision. Initial conflict planning support is in place.
- Use Dropbox `rev` values for guarded writes.
- Use Dropbox `content_hash` for remote change detection.
- Treat Dropbox paths as case-insensitive and detect case conflicts.
- Exclude `.obsidian/**` from vault sync.

## Dropbox App Setup

Vaultbox uses the public Dropbox app key for **Vaultbox for Obsidian**:

```text
k671hqjipp2sdpl
```

The app secret must never be stored in the plugin or committed to the repository.

If you are creating your own Dropbox API app for development, configure it with:

- Scoped access.
- Full Dropbox access.
- PKCE/public clients enabled.
- Scopes for account info, file metadata, and file content read/write.

Vaultbox uses the OAuth code flow without a redirect URI. Dropbox displays an authorization code on screen after approval; paste that code into Vaultbox. The plugin exchanges the code with the PKCE verifier and stores the refresh token in local plugin data.

## Development

Install dependencies:

```bash
npm install
```

Run tests:

```bash
npm test
```

Run Dropbox API E2E tests:

```bash
npm run dropbox:token
npm run test:e2e
```

The E2E suite creates timestamped folders under `VAULTBOX_E2E_DROPBOX_TEST_ROOT`, uploads/downloads/updates/deletes files, verifies stale `rev` conflict behavior, runs the real planner/executor against live Dropbox data, and checks the sync conflict modes before cleaning up by default.

The token helper prints a Dropbox authorization URL, asks you to paste the authorization code shown by Dropbox, and writes the resulting refresh token to `.env.e2e`. Treat `.env.e2e` as secret local state.

Build:

```bash
npm run build
```

Install into a local test vault:

```bash
npm run local-install -- "/path/to/Test Vault"
```

Use a throwaway Dropbox account or folder while developing sync behavior.

## Safety Notes

Dropbox sync changes should be treated as vault-wide changes. Before implementing mutating sync behavior:

- Add focused unit tests for upload, download, delete, and conflict cases.
- Add tests for network errors and stale `rev` conflicts.
- Avoid partial local writes when remote writes fail.
- Keep auth tokens out of synced files.
- Keep `.obsidian/**` excluded unless a future allowlist is deliberately designed.

## License

MIT
