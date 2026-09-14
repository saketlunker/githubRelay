# GitHub Model Relay

Source for the cross-platform **GitHub Model Relay** desktop app and
its headless Windows gateway. It lets Claude Code, Codex CLI, OpenCode, Pi,
and compatible OpenAI/Anthropic clients use models available through a user's
GitHub Copilot subscription without running VS Code.

> **Unofficial community tool.** This project is not affiliated with or
> endorsed by GitHub.

> [!CAUTION]
> This project uses an unofficial, reverse-engineered Copilot backend. It may
> stop working without notice, and automated use can trigger GitHub abuse
> controls or suspension. Use it only for your own interactive development,
> keep the conservative limits enabled, and review the GitHub Copilot terms
> and Acceptable Use Policies. This software does not bypass quotas and does
> not implement account rotation, bulk automation, or resale features.

The wrapper installs exactly pinned
[`@jeffreycao/copilot-api@2.0.1`](https://github.com/caozhiyuan/copilot-api)
with a committed npm lockfile. It does not use the stale `ericc-ch` package,
does not invoke `npx` or `latest` at startup, and does not reimplement model
protocol translation.

## What it provides

- An Electron tray application for Windows, macOS, and Linux that bundles
  Electron/Node and the pinned gateway backend.
- A native settings window for authentication, status, dynamic models and
  reasoning controls, clients, signed updates, and diagnostics.
- Public update metadata and signed installers are published as GitHub
  Releases on this same repository.
- One-command, per-user Windows 10/11 installation from a cloned checkout.
- No administrator requirement under normal Task Scheduler policy.
- No VS Code process or VS Code installation.
- One-time GitHub device authentication persisted in a dedicated data
  directory.
- Automatic hidden startup at user logon through a least-privilege Scheduled
  Task.
- A singleton supervisor with bounded exponential restart backoff.
- A public listener fixed to `127.0.0.1`; LAN binding is rejected.
- Separate public, internal-backend, and admin API keys generated from the
  operating system CSPRNG.
- A streaming reverse proxy that enforces authentication, blocks sensitive
  upstream routes, preserves request/response streaming, and applies
  conservative concurrency/rate limits without inspecting prompt bodies.
- Atomic state writes, immutable releases, exact updates, and pointer-based
  rollback.
- Lossless, backed-up user configuration for Claude Code, Codex, OpenCode,
  and Pi.
- Dynamic model discovery from `/v1/models`, cached aliases, and explicit
  model selection.
- Structured, rotated wrapper logs that omit request bodies and redact known
  credentials.
- Fully offline product tests after dependency restore; CI never authenticates
  or contacts Copilot.

## Architecture

```text
Claude Code / Codex / OpenCode / Pi / API clients
                         |
            127.0.0.1:4141 + client API key
                         |
       streaming auth + rate-limit proxy (Node)
            |      blocks /token and /admin
            |      never reads/logs prompt bodies
                         |
            127.0.0.1:4142 + internal key
                         |
       pinned @jeffreycao/copilot-api@2.0.1
                         |
                  GitHub Copilot

Task Scheduler -> hidden PowerShell launcher -> singleton Node supervisor
```

The desktop application replaces the Task Scheduler launcher with an Electron
tray controller while reusing the same Node supervisor and security boundary.
See [`docs/desktop-product-spec.md`](docs/desktop-product-spec.md) for the
cross-platform architecture, trust model, migration, and acceptance criteria.

## Desktop development

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck:desktop
npm test
npm run pack:desktop
```

`pack:desktop` creates an unpacked development package for the current
platform. Production release publishing is fail-closed until the internal
corporate signing adapter in
[`docs/corporate-signing-contract.md`](docs/corporate-signing-contract.md) is
configured. Never publish the unsigned development installer.

The currently supported package targets are per-user NSIS on Windows, signed
DMG/updater ZIP on macOS, and AppImage/DEB on Linux. The desktop package needs
no external Node.js or VS Code installation.

The maintained upstream already implements Anthropic Messages, OpenAI
Responses, Chat Completions, model discovery, Copilot token refresh, and
provider-specific translation. This project adds only Windows lifecycle,
security boundaries, rate safety, client configuration, and operations.

The public proxy exposes only these route families:

- `/v1/models`
- `/v1/messages` and `/v1/messages/count_tokens`
- `/v1/responses`
- `/v1/chat/completions`
- `/v1/embeddings`
- corresponding `/<provider>/v1/...` routes

Upstream `/token`, `/admin`, `/usage-viewer`, and arbitrary routes are not
reachable through the public port.

## Headless Windows prerequisites

- Windows 10 or Windows 11.
- PowerShell 5.1 or newer.
- Node.js **22.13.0 or newer**, including npm.
- A GitHub account with an active Copilot subscription.
- Network access to npm during installation and to GitHub during
  authentication/use.

Node 20 can start upstream, but Node 22.13 is required for its supported
SQLite usage store and is this project's tested minimum.

Pi additionally needs Bash on Windows, normally Git Bash, and the maintained
package is `@earendil-works/pi-coding-agent`.

## Install

Open PowerShell and run:

```powershell
irm https://raw.githubusercontent.com/saketlunker/githubRelay/main/web-install.ps1 | iex
```

That checks prerequisites, downloads the launcher, verifies its checksum, puts
`githubrelay` on your PATH, and runs setup: GitHub device sign-in, client
configuration for Claude Code / Codex / OpenCode / Pi, and start.

Node.js 22.13 or newer is the only prerequisite; the installer offers to
install it through winget when it is missing or too old. If anything
misbehaves, `githubrelay doctor` prints a redacted report suitable for
sharing.

The installer does not use npm to fetch the launcher. npm 12 defaults to
`allow-remote=none` and `allow-git=none`, so a release tarball URL or a git
spec cannot be handed to `npm install -g`.

See [`packages/npm`](packages/npm) for the launcher and
[`docs/release-feed.md`](docs/release-feed.md) for the release channel.

To work from a checkout instead, clone this repository, open PowerShell in it,
and run:

```powershell
.\install.ps1
```

The immutable release is installed under:

```text
%LOCALAPPDATA%\CopilotHarnessGateway
```

The command:

1. Validates the exact package pin and Node version.
2. Creates a user-only install root and NTFS ACL.
3. Generates three unrelated 256-bit local keys.
4. Runs `npm ci --omit=dev --ignore-scripts` from the committed lockfile into
   a staging release.
5. Verifies the installed backend version and entrypoint.
6. Atomically activates the immutable release.
7. Registers or repairs the current user's hidden logon task.
8. Leaves the desired state stopped until authentication is complete.

Re-running installation is idempotent. It verifies/repairs files and the task
without duplicating releases or rotating credentials.

To inspect the plan without writing, installing, registering a task, or
contacting npm:

```powershell
.\install.ps1 -DryRun
```

Custom test/portable roots are supported:

```powershell
.\install.ps1 -InstallRoot C:\Path\Gateway -SkipTask
```

`-SkipAcl` is intended only for isolated tests; do not use it for a real
installation.

## Authenticate once

Run the installed management command:

```powershell
& "$env:LOCALAPPDATA\CopilotHarnessGateway\gateway.ps1" authenticate
```

Upstream prints a GitHub device verification URL and one-time code. Complete
that flow in a browser. Authentication runs in the foreground and outside the
service supervisor; the supervisor never receives a GitHub token on its
command line.

The GitHub OAuth token is stored by upstream at:

```text
%LOCALAPPDATA%\CopilotHarnessGateway\data\backend\github_token
```

The containing directory is restricted to the current Windows user and
SYSTEM. Credentials are not copied into this repository or printed by this
wrapper.

Upstream also reads or creates a non-secret synthetic editor device ID at
`HKCU\SOFTWARE\Microsoft\DeveloperTools\deviceid`. No VS Code process is
started. Uninstall intentionally leaves this shared registry value in place
because other Copilot tooling may own or use it.

Authentication is persistent, not permanent. GitHub controls its lifetime.
Revocation, expiry, account policy, password/security events, or an upstream
protocol change can require `authenticate` again.

Start the gateway after authentication:

```powershell
& "$env:LOCALAPPDATA\CopilotHarnessGateway\gateway.ps1" start
```

The desired state remains `running`, so the Scheduled Task starts it at future
user logons.

## Discover and select models

Refresh from the authenticated backend:

```powershell
$gateway = "$env:LOCALAPPDATA\CopilotHarnessGateway\gateway.ps1"
& $gateway models -ModelsAction refresh
& $gateway models -ModelsAction list
```

Discovery stores model IDs and safe capability metadata only. It creates
dynamic aliases:

- `claude`: latest suitable Claude Sonnet, then Opus/Claude.
- `codex`: a Codex model, then a GPT model.
- `fast`: Haiku, Luna, Mini, or Flash.
- `default`: Claude, then Codex, then the first deterministic model.

Existing explicit aliases are never silently retargeted. Set one explicitly:

```powershell
& $gateway models -ModelsAction set-alias -Alias default -Model MODEL_ID
```

If a model disappears, health/configuration reports the stale alias and
requires an explicit choice.

## Configure clients

Configuration is additive by default: provider/connection settings are added,
but an existing default model/provider is not replaced. Use `-SetDefault` to
opt in to changing defaults.

```powershell
& $gateway configure-clients -Clients claude,codex,opencode,pi
```

Select models explicitly when needed:

```powershell
& $gateway configure-clients `
  -Clients claude,codex,opencode,pi `
  -ClaudeModel CLAUDE_MODEL_ID `
  -CodexModel CODEX_MODEL_ID `
  -FastModel FAST_MODEL_ID `
  -SetDefault
```

Preview every path and planned mutation without writing:

```powershell
& $gateway configure-clients -Clients all -DryRun
```

The command still generates configuration when a client executable is not
installed. It reports that state without failing the overall setup.

Before each changed existing file, the configurator creates a UTC timestamped
backup. Writes use same-directory temporary files and atomic replacement.
Malformed input and ownership conflicts fail before any write. Re-running an
unchanged configuration creates no new backup.

The local client key is exposed to clients through the current user's
`COPILOT_HARNESS_GATEWAY_API_KEY` environment variable. It is not a GitHub
credential. New terminals inherit it; already running terminals do not.

### Claude Code

Managed file:

```text
%USERPROFILE%\.claude\settings.json
```

The adapter uses Anthropic Messages at `http://127.0.0.1:4141` and an
`apiKeyHelper` that writes only the local key to stdout. It does not replace a
different existing helper without `-Force`.

Claude Code's supported gateway contract is for Claude models. Routing it to a
non-Claude model through a translator may appear to work but is not supported
by Anthropic and can break tool/reasoning semantics. The adapter rejects that
choice unless explicitly forced.

Existing `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY` process variables can
take precedence over the helper. Remove them from the launching environment if
Claude Code still uses another endpoint/key.

### Codex CLI

Managed file:

```text
%CODEX_HOME%\config.toml
```

or, when `CODEX_HOME` is unset:

```text
%USERPROFILE%\.codex\config.toml
```

The adapter adds `model_providers.copilot_harness_gateway` with:

- base URL `http://127.0.0.1:4141/v1`
- `wire_api = "responses"`
- the local key environment variable
- OpenAI authentication disabled
- WebSocket transport disabled

Current Codex requires Responses; Chat Completions is not a safe tool-semantic
fallback. Existing top-level `model` and `model_provider` values are preserved.
Without `-SetDefault`, invoke it explicitly:

```powershell
codex --config 'model_provider="copilot_harness_gateway"' --model MODEL_ID
```

### OpenCode

Managed configuration is resolved using `OPENCODE_CONFIG`,
`XDG_CONFIG_HOME`, and then:

```text
%USERPROFILE%\.config\opencode\config.json
%USERPROFILE%\.config\opencode\opencode.json
%USERPROFILE%\.config\opencode\opencode.jsonc
```

OpenCode loads these in the order shown, so the adapter patches the
highest-precedence existing file (JSONC when present). It
uses `jsonc-parser` to preserve comments and trailing commas and refuses
ambiguous duplicate provider ownership across multiple files.

The provider uses bundled `@ai-sdk/anthropic`, Anthropic Messages at
`http://127.0.0.1:4141/v1`, environment substitution for the local key, and
the dynamically discovered model catalog. When `enabled_providers` already
restricts the provider catalog, the adapter adds only its own provider ID and
tracks that array member independently for safe uninstall.

### Pi coding agent

Managed files:

```text
%PI_CODING_AGENT_DIR%\models.json
%PI_CODING_AGENT_DIR%\settings.json
```

or:

```text
%USERPROFILE%\.pi\agent\models.json
%USERPROFILE%\.pi\agent\settings.json
```

The provider uses `anthropic-messages`, the gateway root URL, and
`$COPILOT_HARNESS_GATEWAY_API_KEY`. Model entries contain discovered IDs only;
Pi supplies its documented conservative defaults instead of this project
inventing context/output limits.

## Other OpenAI/Anthropic clients

After `configure-clients` has set the user environment variable:

| Protocol | Base URL | Authentication |
|---|---|---|
| OpenAI Responses/Chat | `http://127.0.0.1:4141/v1` | `Authorization: Bearer $env:COPILOT_HARNESS_GATEWAY_API_KEY` or `x-api-key` |
| Anthropic Messages | `http://127.0.0.1:4141` | `x-api-key: $env:COPILOT_HARNESS_GATEWAY_API_KEY` |

Example model discovery:

```powershell
Invoke-RestMethod `
  -Uri http://127.0.0.1:4141/v1/models `
  -Headers @{ 'x-api-key' = $env:COPILOT_HARNESS_GATEWAY_API_KEY }
```

The gateway does not expose an unauthenticated compatibility mode.

## Management

```powershell
$gateway = "$env:LOCALAPPDATA\CopilotHarnessGateway\gateway.ps1"

& $gateway start
& $gateway stop
& $gateway restart
& $gateway status
& $gateway status -Json
& $gateway health
& $gateway health -Deep
& $gateway logs -Tail 200
& $gateway logs -Follow
```

`health` checks the local supervisor/backend state. `health -Deep` performs an
authenticated `/v1/models` request.

The supervisor restarts unexpected backend exits with jittered exponential
backoff from one to sixty seconds, up to eight failures per fifteen minutes.
After that it remains in a visible `blocked-restart-limit` state instead of
creating a restart storm. Task Scheduler separately retries a crashed
supervisor three times at one-minute intervals.

Only one supervisor owns an installation. A lock records its PID and random
instance identity. Stale locks and orphaned backend PIDs are removed only after
process identity checks; an unrelated process is never killed because it
reused a PID or port.

## Logs and diagnostics

Wrapper logs:

```text
%LOCALAPPDATA%\CopilotHarnessGateway\logs\supervisor.jsonl
```

They contain lifecycle, status code, duration, and endpoint path only. Request
or response bodies are never parsed or logged. Known credentials and
credential-shaped fields are redacted before persistence and again when read
through the management command. Logs rotate at 5 MiB with five retained files
by default.

Upstream's non-verbose operational logs are redirected to:

```text
%LOCALAPPDATA%\CopilotHarnessGateway\logs\upstream
```

The wrapper never enables upstream `--verbose`, `--show-token`,
`--github-token`, or `--claude-code`. Upstream owns those raw operational log
formats; keep their directory ACL-protected. Verbose upstream mode can contain
prompts and is intentionally unsupported by this wrapper.

Useful diagnostics:

```powershell
& $gateway status -Json
& $gateway health -Deep
& $gateway logs -Tail 300
```

No diagnostic command prints the local API keys or GitHub token.

## Update and rollback

Updates are always explicit. `latest`, ranges, and floating tags are rejected:

```powershell
.\gateway.ps1 update `
  -InstallRoot "$env:LOCALAPPDATA\CopilotHarnessGateway" `
  -Version 2.0.2 `
  -ExpectedIntegrity 'sha512-...'
```

Updates must be run from a reviewed checkout whose `package.json` and
`package-lock.json` already pin the requested backend version. The updater
never resolves a new transitive dependency graph at runtime:

1. Requires exact semver, the matching committed source lock, and optionally
   verifies a separately supplied npm SRI.
2. Stops the gateway.
3. Snapshots backend state under the protected backup directory.
4. Copies and verifies the reviewed committed lock in staging.
5. Runs `npm ci`, verifies version/SRI/entrypoint, and records the lock hash.
6. Installs a new immutable release without deleting the previous one.
7. Atomically switches active state and, when it was running, restarts and
   health-checks it.
8. Restores the previous active pointer and service state if activation fails.

Rollback switches to the previously verified immutable release:

```powershell
& $gateway rollback
```

Upstream may add defaults to its shared `config.json`. Every update snapshots
the protected backend state, but reverse data-schema compatibility ultimately
depends on upstream. Keep backups until the new pin has been exercised.

## Uninstall

By default uninstall removes the exact Scheduled Task, restores/removes only
client values still owned by this project, clears the user environment variable
only when it still equals the generated key, and deletes only paths underneath
a validated install-root marker:

```powershell
& $gateway uninstall
```

Preserve authentication, gateway configuration, keys, and backups for a later
reinstall:

```powershell
& $gateway uninstall -PreserveState
```

Leave client configuration untouched:

```powershell
& $gateway uninstall -KeepClientConfiguration
```

Uninstall refuses deletion when the install-root ownership marker is missing
or changed. It never removes arbitrary parent directories.

## Installed layout

```text
%LOCALAPPDATA%\CopilotHarnessGateway\
  gateway.ps1                 stable management entrypoint
  launcher.ps1                stable hidden task entrypoint
  versions\                   immutable wrapper/backend releases
  config\gateway.json         non-secret bounded configuration
  secrets\secrets.json        local keys; user/SYSTEM ACL only
  data\backend\               upstream auth/config/SQLite state
  state\                      active release, desired/runtime state, models
  logs\                       wrapper and upstream operational logs
  backups\                    client, backend, and update backups
  staging\                    incomplete releases; never active
```

## Security boundaries and threat model

### Defended

- Remote/LAN access: both proxy and backend bind explicitly to IPv4 loopback,
  and startup probes reject a backend reachable on a non-loopback interface.
- Unauthenticated local access: the public API requires a generated key.
- Upstream token extraction: sensitive upstream routes are not exposed.
- Browser drive-by access: non-loopback `Origin` values are rejected and
  upstream wildcard CORS headers are stripped.
- Dependency drift: initial install uses exact versions, SRI values, and a
  committed npm lockfile.
- Startup duplication: singleton lock plus Task Scheduler
  `MultipleInstances=IgnoreNew`.
- Log leakage: no body logging, bounded fields, default non-verbose upstream,
  and secret redaction.
- Destructive uninstall: marker validation and explicit child paths.

### Not defended

- Another process running as the same Windows user. It can read user files,
  environment variables, process memory, or connect to loopback. The local API
  key is an accidental-exposure boundary, not a sandbox against the account
  owner.
- Administrators, SYSTEM, kernel malware, debuggers, or a compromised Node
  runtime.
- GitHub service-side enforcement, availability, protocol changes, model
  removal, or OAuth revocation.
- Semantic gaps in upstream protocol translation.
- Prompt/source-code handling by GitHub and model providers under their terms.
- A malicious npm registry serving content that nevertheless matches a
  compromised publisher's valid integrity/provenance. Review pins before
  updating.

Credentials are plaintext at rest within a restricted NTFS directory because
that is upstream's supported storage model. Windows administrators can still
take ownership.

See [SECURITY.md](SECURITY.md) and
[upstream qualification](docs/upstream-qualification.md) for more detail.

## Conservative usage policy

Defaults are intentionally modest:

- 2 concurrent inference/model requests.
- 20 requests per minute with burst 4.
- No inference request retries in the wrapper.
- 15-minute idle request timeout.
- 8 backend restarts per 15-minute window.

Change these only for normal interactive use and at your own account risk.
The project will not add quota bypassing, account pools, rotation, bulk
generation, or LAN/multi-user serving.

## Troubleshooting

### `blocked-auth`

Run:

```powershell
& $gateway authenticate
& $gateway start
```

Re-authentication may be required after GitHub revocation or expiry.

### `blocked-restart-limit`

Inspect logs, fix the reported network/configuration/port problem, then:

```powershell
& $gateway restart
```

### Port already in use

The public and internal ports default to 4141 and 4142. Stop the owner or edit
`config\gateway.json` while the gateway is stopped. Both addresses must remain
`127.0.0.1`, ports must be 1024-65535, and the ports must differ.

For an authenticated enterprise proxy, set
`network.proxyFromEnvironment` to `true` while stopped, then restart. Only the
standard HTTP/HTTPS/ALL proxy variables are passed to upstream; loopback is
always added to `NO_PROXY`.

### Client receives 401

Open a new terminal after client configuration, then verify:

```powershell
$env:COPILOT_HARNESS_GATEWAY_API_KEY.Length
```

Do not print the value. Re-run `configure-clients` if the variable is absent.

### Claude Code uses another provider

Check for process-level `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`,
`ANTHROPIC_BASE_URL`, Bedrock, or Vertex settings with higher precedence. Start
a new Claude Code process after changes.

### Codex fails before inference

Confirm the provider uses `wire_api = "responses"` and `/v1` as the base URL.
Current Codex does not accept Chat Completions as a tool-compatible wire API.

### OpenCode JSONC conflict

When both global JSON and JSONC define this project's provider, remove one
duplicate manually. The configurator refuses to guess which value you intended.

### Scheduled Task denied

Enterprise policy can prohibit per-user task registration even without admin.
Installation reports the failure rather than claiming success. An interactive
`start -SkipTask` fallback is available, but it does not provide logon startup
or Task Scheduler crash recovery.

## Known limitations

- The backend is unofficial and can break when GitHub changes internal APIs or
  abuse controls.
- GitHub's short-lived Copilot token is refreshed automatically, but the
  persisted OAuth token can still expire or be revoked.
- Claude Code officially supports Claude models through gateways, not
  arbitrary translated models.
- Some managed Claude Code deployments require HTTPS gateways. This project
  intentionally serves loopback HTTP only and will not satisfy such a policy.
- Upstream's Anthropic/OpenAI compatibility is extensive but not complete;
  PDF blocks, beta flags, reasoning continuity, web search, and translated
  tool results can differ by model.
- Upstream starts only after live GitHub/token/model initialization; there is
  no fully offline inference mode.
- The public safety proxy supports streaming HTTP/SSE, not OpenAI Responses
  WebSocket upgrades. Codex is configured with WebSockets disabled.
- Same-user clients can retrieve/use the local client key.
- Task Scheduler behavior under every enterprise/domain policy requires local
  qualification.
- Windows on ARM can run Node's supported architecture, but this repository's
  CI covers the hosted x64 runner.

## Supported official alternative

GitHub's official **Copilot CLI and Copilot SDK** are the supported integration
path when their agent/tool contract fits the application. They do not expose a
raw OpenAI- or Anthropic-compatible model API, so they are not drop-in backends
for Claude Code, Codex custom providers, or arbitrary API clients.

Use the official alternative when raw compatibility is not required.

## Development and tests

Restore the committed dependencies:

```powershell
npm ci --ignore-scripts
```

Run Node and Windows management tests:

```powershell
npm test
pwsh -NoProfile -File .\tests\powershell\run-tests.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\tests\powershell\run-tests.ps1
pwsh -NoProfile -File .\tests\powershell\install-integration.ps1
```

Tests use a deterministic fake loopback backend, fixture model catalogs, and
worktree-local temporary roots. They never authenticate, read real client
configuration, or contact Copilot.

## License and attribution

This private wrapper installs upstream dependencies under their own licenses.
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and
[`licenses/copilot-api-MIT.txt`](licenses/copilot-api-MIT.txt).
