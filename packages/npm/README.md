# githubrelay

One-line installer for **GitHub Model Relay**. It turns your own GitHub Copilot
subscription into a local, loopback-only API that Claude Code, Codex, OpenCode,
and Pi can talk to — without running VS Code.

> **Unofficial community tool.** Not affiliated with or endorsed by GitHub.

## Install

```
npm install -g githubrelay && githubrelay setup
```

`setup` walks through five steps: prerequisite checks, gateway install, GitHub
device sign-in, client configuration, and start. Sign-in opens a browser and
asks for a device code, so it runs as an explicit step rather than silently
during `npm install`.

## Requirements

- Windows 10 or 11
- Node.js 22.13.0 or newer
- An eligible GitHub Copilot subscription

Nothing else. You do **not** need VS Code, the GitHub CLI, or a Copilot
extension. The relay performs its own device sign-in.

## Everyday commands

| Command | What it does |
| --- | --- |
| `githubrelay status` | Show gateway status |
| `githubrelay health` | Run a health check |
| `githubrelay logs -Tail 200` | Show recent logs |
| `githubrelay models` | List or refresh available models |
| `githubrelay start` / `stop` / `restart` | Control the gateway |
| `githubrelay clients` | Re-apply client configuration |
| `githubrelay auth` | Re-run GitHub sign-in |
| `githubrelay doctor` | Print a redacted report for support |

## When something breaks

```
githubrelay doctor
```

This prints prerequisites, gateway status and health, recent logs, and which
clients were detected. Secrets are redacted before the report is produced, and
your home directory is shortened to `~`. Review it once, then share it.

To write it to a file instead:

```
githubrelay doctor --out relay-report.md
```

## Updating

The launcher checks for a newer release on startup and updates itself. To
disable that:

```
set GITHUBRELAY_DISABLE_AUTO_UPDATE=1
```

Use `GITHUBRELAY_OFFLINE=1` to skip all startup network calls.

## Limitations

The backend is unofficial and reverse-engineered. GitHub can change service
behavior or enforce abuse controls at any time. The relay does not bypass
quotas, pool accounts, or listen beyond `127.0.0.1`.

Source: https://github.com/saketlunker/githubRelay
