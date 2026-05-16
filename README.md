# Vaultbox

Vaultbox is an Obsidian plugin for syncing a vault directly with a selected Dropbox folder on desktop and mobile.

The goal is to support people who already keep an Obsidian vault in Dropbox on a desktop machine, but cannot use that same Dropbox folder from Obsidian mobile. Vaultbox will talk to the Dropbox API from inside Obsidian so phones and tablets can sync against the same Dropbox folder without relying on the Dropbox desktop client or local Git.

## Current Status

This repository is the first scaffold. It includes:

- Obsidian plugin build/test setup.
- Dropbox OAuth code flow with PKCE and offline refresh tokens.
- Full Dropbox folder-path configuration.
- A starter Dropbox API client for listing, validating, uploading, downloading, and deleting files.
- Tests around the auth and Dropbox API assumptions.

The sync engine is not wired yet. The intended implementation is the same conservative shape as Octosync: plan first, simulate, detect conflicts, and stop rather than guessing.

## Product Direction

Vaultbox will request Full Dropbox access because the core use case is syncing an existing vault folder that may already be managed by the Dropbox desktop app. The plugin should only operate inside the selected folder path and the README/settings UI should stay explicit about that permission tradeoff.

Planned behavior:

- Pick or enter an existing Dropbox folder.
- Sync manually or automatically.
- Simulate planned changes before applying them.
- Detect local/remote conflicts and ask for a decision.
- Use Dropbox `rev` values for guarded writes.
- Use Dropbox `content_hash` for remote change detection.
- Treat Dropbox paths as case-insensitive and detect case conflicts.
- Exclude `.obsidian/**` from vault sync.

## Dropbox App Setup

Create a Dropbox API app with:

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
