# GitHub Model Relay Desktop Specification

Status: Implementation draft

Source and public releases: `saketlunker/githubRelay`

Distribution label: **Unofficial community tool**

## Purpose

GitHub Model Relay is a per-user desktop application that exposes models
available through a user's GitHub Copilot subscription to local coding
harnesses through loopback-only OpenAI and Anthropic compatible APIs. It
bundles its runtime, starts at login when enabled, preserves authentication,
configures supported clients safely, and updates from a signed public release
feed without requiring VS Code.

The application reports model and capability metadata returned by GitHub. It
cannot independently attest the physical model weights or inference compute.

## Goals

- One signed installer for Windows, macOS, and Linux.
- No external Node.js, VS Code, Copilot extension, or GitHub CLI.
- Bounded device authentication for each user's own GitHub account.
- Numeric loopback listeners with distinct local API credentials.
- Claude Code, Codex, OpenCode, Pi, and compatible API clients.
- Dynamic models, endpoints, capabilities, aliases, and reasoning controls.
- No silent model or reasoning downgrade.
- Tray lifecycle, accessible settings, diagnostics, and launch at login.
- Signed public updates without a shared GitHub token.
- Continued support for the existing headless Windows CLI.

## Non-goals

- Bypassing quotas, policy, rate limits, or abuse detection.
- Account pooling, credential sharing, resale, or bulk automation.
- LAN/public listeners.
- Reimplementing upstream protocol translation.
- Guaranteeing stability of an unofficial reverse-engineered backend.
- Installing third-party harnesses without explicit approval.

## Platforms

| Platform | Package | Update behavior |
| --- | --- | --- |
| Windows 10/11 x64/arm64 | Per-user NSIS | In-app |
| Current macOS x64/arm64 | Signed DMG and updater ZIP | In-app |
| Linux x64/arm64 | AppImage and DEB | AppImage in-app; DEB prompt |

Unsupported architecture/package combinations fail during build, not at
runtime.

## User journeys

### First run

1. Verify that OS credential storage is encrypted. Linux `basic_text` is
   rejected for GitHub credentials.
2. Generate separate client, internal, and administrative local keys.
3. Display the GitHub device URL and code until success, cancel, expiry, or
   timeout.
4. Start the gateway and run deep health/model discovery.
5. Detect clients and preview backed-up, atomic configuration changes.
6. Offer launch at login as an explicit preference.

### Daily use

Closing settings leaves the tray application active. Tray actions are Open
Settings, Start, Stop, Restart, Check for Updates, Diagnostics, and Quit.

### New models

Refresh preserves complete sanitized metadata. Models using existing
Responses or Messages protocols work without an app update. Unknown safe
reasoning values remain visible and are passed through unchanged.

### Upgrade

The app installs only assets matching a signed release manifest, platform,
architecture, channel, schema compatibility, size, and SHA-256. Failed
migrations or health checks retain a signed rollback path.

## Settings interface

- **Overview:** status, endpoint, versions, auth state, launch at login, and
  start/stop/restart/deep-health controls.
- **Models:** searchable capabilities, dynamic reasoning selector, aliases,
  endpoint selection, and probe results.
- **Clients:** detection, preview, configure, restore, conflict details, and
  backup location.
- **Updates:** stable/beta channel, notes, progress, signature state, restart,
  and cached rollback.
- **Security/Diagnostics:** loopback/auth/rate state, secure-storage backend,
  redacted logs, paths, diagnostic export, and logout.

The renderer is keyboard accessible, follows system light/dark and reduced
motion, has visible focus/high contrast, and avoids a marketing dashboard
layout.

## Architecture

```text
Sandboxed settings renderer
          |
typed allowlisted preload API
          |
Electron main / desktop controller ----- signed public updater
          |
shared model/client/state modules
          |
child: existing Node supervisor
          |
127.0.0.1:4141 + client key
          |
authenticated streaming proxy
          |
127.0.0.1:4142 + internal key
          |
pinned @jeffreycao/copilot-api
          |
GitHub Copilot
```

Electron main owns desktop lifecycle and starts the existing supervisor with
Electron's executable in Node mode. The supervisor remains the only API
listener and security boundary; the desktop app does not implement another
proxy. Renderer failure cannot reconfigure or stop the gateway.

Shared modules own atomic files, state schemas, capability sanitization, client
plans/ownership, platform paths, release manifest verification, and migration.
The desktop controller and headless CLI reuse these modules.

## Data and migration

| Platform | State root |
| --- | --- |
| Windows | `%LOCALAPPDATA%\GitHubModelRelay` |
| macOS | `~/Library/Application Support/GitHub Model Relay` |
| Linux | `$XDG_STATE_HOME/github-model-relay` or `~/.local/state/github-model-relay` |

State includes `config`, `state`, `secrets`, `data/backend`, `logs`, `backups`,
`updates`, and immutable versions. Cache data uses the platform cache root.

Windows migration validates the old ownership marker, state, immutable
release, and task; stops it through authenticated shutdown; snapshots and
stages data; starts the bundled supervisor; verifies health, models, and
client key; then removes the old task. Any earlier failure restores the old
installation.

## Credential and security boundaries

Production desktop builds encrypt authentication adapter state with Electron
`safeStorage`. Linux must reject persistence when
`safeStorage.getSelectedStorageBackend()` reports `basic_text`. The current
upstream adapter may materialize its token in a user-only backend directory;
logout removes stale copies. A future official adapter can replace it without
changing the UI or client contracts.

The local client key is not a GitHub credential, but remains user-protected and
is never logged.

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`.
- Fixed typed preload methods; no generic IPC send/invoke.
- Main-process validation for every IPC argument.
- Local renderer, strict CSP, no remote scripts/fonts, denied navigation and
  windows, allowlisted HTTPS external links.
- Single application instance.
- Numeric loopback listeners, constant-time keys, blocked sensitive upstream
  routes, streamed bodies, bounded concurrency/rates/timeouts.
- Structured rotated logs without prompts, responses, images, tools, or keys.
- Production update fails closed without OS and manifest signatures.

## Capability-driven models

The catalog stores complete bounded, sanitized `/v1/models` objects. It removes
fields whose keys imply tokens, credentials, prompts, instructions, messages,
or content and bounds strings, arrays, nesting, and total bytes.

The UI derives endpoints, reasoning choices, streaming, tools, vision,
structured output, modalities, and limits from metadata. Safe unknown fields
and unknown reasoning strings such as `extra-max` survive discovery, cache,
IPC, display, and request planning. Client adapters may reject closed-enum
values with an explicit message; they never substitute another value.

Aliases are recommendations rather than routing identities. Capability/vendor
metadata is preferred, natural ordering is second, and name heuristics are a
final fallback. Explicit aliases are never silently retargeted.

Model probes record requested/returned model and reasoning when available,
endpoint, latency, timestamp, and outcome. This is operational evidence, not
cryptographic model attestation.

## Client contracts

Every integration follows plan, validate, backup, atomic apply, verify, and
ownership record. Restore touches only values still equal to the last applied
value.

- Claude Code: Anthropic Messages plus explicit Opus/Sonnet/Haiku aliases.
- Codex: OpenAI Responses and a named provider.
- OpenCode: Anthropic provider and ownership of only its inserted allowlist
  member.
- Pi: `anthropic-messages` at the gateway root.

Windows can use the user environment store for the local key. macOS/Linux use
an app-owned helper when supported and otherwise show explicit shell
integration; arbitrary shell profiles are not silently rewritten.

## Release flow

Builds publish only verified artifacts to releases on the public
`saketlunker/githubRelay` repository.

1. Approved version tag runs all target tests.
2. Build installers/updater metadata, SBOMs, and SHA-256 files.
3. Submit artifacts to a fixed corporate signing adapter using short-lived
   OIDC.
4. Independently verify Authenticode, macOS signing/notarization, and Linux
   detached signatures.
5. Generate canonical release metadata and obtain a corporate signature.
6. Verify every signed asset again.
7. A narrowly scoped publisher creates a draft public release and promotes it
   only after verification.

No production workflow accepts an arbitrary signing command or endpoint from a
pull request.

The signed manifest contains product, exact version, stable/beta channel,
publication time, minimum application/data/gateway/client schemas, assets by
platform/architecture/format, size, SHA-256, updater metadata hash, signing
policy, rollout percentage, and revocation state.

`electron-updater` reads the public feed without authentication. Startup,
manual, and jittered periodic checks use ETags. Before install, the app
verifies the separately signed manifest, asset hash/size, schema compatibility,
channel, target, and OS signature. It never falls back to an unsigned direct
download.

## Failure and privacy behavior

- Missing auth leaves settings available and reports `blocked-auth`.
- Occupied ports never trigger termination of an unverified process.
- Backend crashes use bounded exponential restart.
- Corrupt state is preserved for diagnostics rather than overwritten.
- Client conflicts produce no partial writes.
- Invalid updates are quarantined.
- Secure-storage failure blocks GitHub credential persistence.

Telemetry is absent by default. Any future telemetry requires a separate
specification and explicit opt-in.

## Acceptance criteria

- Fresh supported machine installs without Node or VS Code.
- Visible, cancellable, bounded device flow.
- Tray survives window close and login start is explicit.
- Loopback only, unauthenticated requests rejected, sensitive routes blocked.
- Claude, Codex, OpenCode, and Pi fixture/integration requests pass.
- Unknown model IDs and safe reasoning values require no app update.
- No silent model/reasoning substitution.
- Client preview/apply/restore is lossless and idempotent.
- Production updater rejects missing/invalid signatures and hashes.
- Existing headless tests pass.
- Windows development package builds locally.
- macOS/Linux package definitions run on approved runners.

## Delivery phases

1. Shared contracts, typed IPC, secure Electron shell, tray, status, platform
   paths, capability helpers, and manifest verification.
2. Bundled supervisor, auth, models/probes, clients, and Windows migration.
3. Packaging, updater, signing adapter, release tooling, SBOMs, and workflows.
4. Signed platform pilots, migration rehearsal, staged rollout, and rollback
   exercise.

## Limitations

- The backend is unofficial and reverse-engineered; GitHub can change it or
  enforce abuse controls.
- GitHub controls authentication lifetime.
- Model/capability values are server claims, not attestation.
- Closed-enum clients may need updates for genuinely new protocol values.
- Corporate signing cannot be exercised until its service contract and
  approved runner identities are supplied.
- Existing managed-account workflows are blocked before checkout until hosted
  runners or approved self-hosted labels are enabled.
