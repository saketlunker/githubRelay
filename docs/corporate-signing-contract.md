# Corporate Signing Integration Contract

GitHub Model Relay production releases fail closed until the internal signing
service is integrated. No private signing key is stored in GitHub, the source
repository, the public release repository, or the desktop application.

## Required trust model

- GitHub Actions uses an approved protected environment.
- The job receives a short-lived OIDC identity (`id-token: write`).
- A corporate client exchanges that identity directly with the signing service.
- The client accepts artifact paths and a declared artifact class; it does not
  accept an arbitrary shell command.
- Signed artifacts are written to a separate output directory.
- The workflow independently verifies signatures and hashes before publishing.

## Adapter executable

The protected environment variable `MODEL_RELAY_SIGNING_CLIENT` contains an
absolute path to an approved executable named
`model-relay-corporate-signing-client` (or `.exe`). The repository wrapper
invokes it with `shell: false`:

```text
model-relay-corporate-signing-client sign
  --input <absolute path>
  --output <absolute path>
  --class windows|macos|linux|manifest
  --oidc-audience github-model-relay-signing

model-relay-corporate-signing-client verify
  --input <absolute path>
  --class windows|macos|linux|manifest
```

The client obtains OIDC from the runner environment and must not accept a
long-lived key argument. Exit code zero means all artifacts were processed.

## Platform evidence

- Windows: Authenticode chain, timestamp, expected publisher, and signed NSIS
  installer plus packaged executable.
- macOS: Developer ID chain, hardened runtime, notarization ticket, and stapled
  DMG/application.
- Linux: detached Ed25519 signature for AppImage and DEB plus expected key ID.
- Manifest: detached Ed25519 signature over the exact canonical JSON bytes;
  `release-manifest.sig` contains the signature in base64 text form.

The private workflow must be updated with the approved publisher identities,
Linux public key, manifest public key, runner labels, and internal client
installation path before a production tag is allowed.

## GitHub configuration

Protected environment: `model-relay-production`

Environment variables:

- `MODEL_RELAY_SIGNING_CLIENT`
- `MODEL_RELAY_WINDOWS_PUBLISHER`
- `MODEL_RELAY_MACOS_TEAM_ID`
- `MODEL_RELAY_LINUX_SIGNING_KEY_ID`
- `MODEL_RELAY_MANIFEST_KEY_ID`

Release publishing uses the workflow's built-in `GITHUB_TOKEN` with
`contents: write`, because source and releases share one repository. No
cross-repository publishing token is required.

Repository variables:

- `WINDOWS_RUNNER_LABEL`
- `MACOS_RUNNER_LABEL`
- `LINUX_RUNNER_LABEL`

Pull-request workflows never receive this environment or its identity.
