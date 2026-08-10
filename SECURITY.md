# Security policy

## Scope

Copilot Harness Gateway is a private, single-user, loopback-only compatibility
wrapper. It is not designed as a shared service, LAN gateway, hosted proxy, or
security boundary between processes running as the same Windows user.

## Secrets

Never commit:

- `github_token`
- `ent_github_token`
- `codex_credentials.json`
- `secrets.json`
- API keys
- copied client configuration
- logs or SQLite state

Runtime credentials live only below
`%LOCALAPPDATA%\CopilotHarnessGateway` and inherit an explicit NTFS ACL for the
current user and SYSTEM. The backend's supported credential store uses
plaintext files; Windows administrators can take ownership.

The service must never be launched with upstream `--github-token`,
`--show-token`, or `--verbose`.

## Listener policy

Both listener addresses are fixed to `127.0.0.1`. Configuration that requests
`0.0.0.0`, a LAN address, or IPv6-any is rejected. The supervisor also probes
non-loopback local interfaces after backend startup and fails closed if the
internal port is reachable.

The public proxy requires a generated API key and exposes only approved
OpenAI/Anthropic route families. It blocks upstream `/token`, `/admin`, root,
and usage-viewer routes.

## Dependency/update policy

- The repository backend dependency is an exact version.
- `package-lock.json` and npm SRI values are committed.
- Installation uses `npm ci --ignore-scripts`, never `npx`.
- Update requires exact semver and, for a new upstream pin, expected npm SRI.
- Previous immutable releases are retained for rollback.
- Review upstream source, release provenance, license, and protocol changes
  before approving a pin.

## Logging

Wrapper logs never parse or persist inference bodies. They contain bounded
lifecycle and request metadata only. Known credentials and credential-shaped
fields are redacted before persistence.

The upstream package writes separate operational logs. They are ACL-protected,
run with verbose mode disabled, and remain an upstream trust boundary.

## Responsible use

Do not use this project for quota bypassing, account rotation, bulk automated
generation, resale, or serving other users. GitHub can warn, throttle, suspend,
or revoke Copilot access when activity triggers abuse controls.

## Reporting

Because this is a private repository, report suspected vulnerabilities through
the repository's private security reporting channel or directly to its owner.
Do not include live credentials, prompts, source code from logs, or OAuth
tokens in an issue.

Vulnerabilities in `@jeffreycao/copilot-api` should also be reported to that
upstream maintainer without disclosing this installation's secrets.
