# Contributing to Vaultbox

Vaultbox is early. The most important rule is to protect user vaults: prefer explicit planning, conservative conflict handling, and focused tests over broad behavior.

## Setup

```bash
npm install
npm test
npm run build
```

Install into a local test vault:

```bash
npm run local-install -- "/path/to/Test Vault"
```

## Dropbox Testing

The default Dropbox app key belongs to **Vaultbox for Obsidian** and is safe to commit because app keys are public. Never commit a Dropbox app secret.

Use a throwaway Dropbox account or a disposable folder. Do not test sync behavior against your main vault until conflict, delete, and failure paths are covered.

## Sync Safety

When changing sync logic:

- Build a plan before applying changes.
- Use Dropbox `rev` values for guarded remote writes.
- Use Dropbox `content_hash` for remote comparison.
- Treat deletes as high risk.
- Detect same-path and case-only conflicts.
- Avoid partial local mutations after a remote failure.
- Keep `.obsidian/**` out of sync.

## Release Notes

Keep `manifest.json`, `versions.json`, `package.json`, and `package-lock.json` aligned. The GitHub release tag must match `manifest.json.version`.
