# Public release and update feed

> **Unofficial community tool.** This project is not affiliated with or
> endorsed by GitHub.

Signed installers and update metadata are published as GitHub Releases on this
repository, `saketlunker/githubRelay`. Source and releases share one
repository, so the desktop updater and the release workflow both target it
directly.

## Availability

No production release is published yet. Do not install test or unsigned
artifacts shared outside a GitHub Release from this repository.

When releases begin, supported packages will be:

- Windows 10/11: per-user NSIS installer
- macOS: signed and notarized DMG plus updater ZIP
- Linux: signed AppImage and DEB

The application bundles its runtime. Users do not need VS Code, Node.js,
GitHub CLI, or a Copilot extension. Each user signs into their own GitHub
account and must have an eligible Copilot subscription.

## Update security

Production releases must include:

- operating-system code signing (and macOS notarization)
- `release-manifest.json` and detached `release-manifest.sig`
- SHA-256 and byte size for every platform/architecture asset
- updater metadata hashes, schema compatibility, and release channel
- an SBOM and checksums

The desktop updater fails closed when signatures, hashes, target metadata, or
compatibility checks are missing or invalid.

## Important limitations

The backend is unofficial and reverse-engineered. GitHub can change service
behavior, require authentication again, or enforce abuse controls. The app
does not bypass quotas, pool accounts, or expose the API beyond loopback.
Model identity and reasoning metadata are server claims, not cryptographic
attestation.

## Publishing the npm launcher

The `githubrelay` npm package is published by the
[`publish-npm.yml`](../.github/workflows/publish-npm.yml) workflow, never from
a maintainer's machine. GitHub-hosted runners reach `registry.npmjs.org`
directly, and npm trusted publishing only supports cloud-hosted runners.

To ship a release:

1. Bump `version` in the repository `package.json`.
2. Run `node scripts/build-npm-payload.mjs`, which syncs the launcher version.
3. Update `version` in `releases/prod/latest.json` to match.
4. Commit, then push a matching tag: `npm-v0.2.3`.

The workflow refuses to publish when the tag, the launcher `package.json`, and
`releases/prod/latest.json` disagree. A manifest ahead of the published package
would make every installed launcher try to update on every run.

Use the `workflow_dispatch` trigger with `dry_run` left enabled to pack and
validate a release without publishing it.

### Credentials

The first publish needs an `NPM_TOKEN` repository secret, because a trusted
publisher can only be configured against a package that already exists.

Afterwards, configure trusted publishing on npmjs.com under Settings →
Trusted publishing for the `githubrelay` package, pointing at this repository
and the `publish-npm.yml` workflow. The workflow already requests
`id-token: write`, so OIDC takes over and `NPM_TOKEN` can be deleted. Trusted
publishing also attaches provenance automatically.
