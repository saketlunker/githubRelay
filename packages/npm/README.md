# githubrelay

One-line installer for **GitHub Model Relay**. It turns your own GitHub Copilot
subscription into a local, loopback-only API that Claude Code, Codex, OpenCode,
and Pi can talk to — without running VS Code.

> **Unofficial community tool.** Not affiliated with or endorsed by GitHub.

## Install

```powershell
npm install -g githubrelay@latest
githubrelay setup
```

`setup` walks through five steps: prerequisite checks, gateway install, GitHub
device sign-in, client configuration, and start. Sign-in opens a browser and
asks for a device code, so it runs as an explicit step rather than silently
during install. npm 12 blocks dependency lifecycle scripts by default, so no
`postinstall` is used.

On a machine without Node.js, this installs Node through winget first and then
does the same thing:

```powershell
irm https://raw.githubusercontent.com/saketlunker/githubRelay/main/web-install.ps1 | iex
```

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
| `githubrelay clients` | Re-link coding agents to the relay |
| `githubrelay shortcut` | Recreate the desktop re-link shortcut |
| `githubrelay auth` | Re-run GitHub sign-in |
| `githubrelay doctor` | Print a redacted report for support |

## Day to day

Nothing to do. The gateway starts when you sign in to Windows through a
least-privilege scheduled task, and your agents are already pointed at it.

The one recurring step: after installing a **new** coding agent, run
`githubrelay clients` — or double-click the desktop shortcut
**Connect coding agents to GitHub Relay** — so that agent learns about the
relay.

## When something breaks

```
githubrelay doctor
```

This prints prerequisites, gateway status and health, recent logs, and the
state of each coding agent. Secrets are redacted before the report is produced
and your home directory is shortened to `~`. Review it once, then share it.

It also catches failures that are easy to misread. npm 12 blocks dependency
lifecycle scripts by default, and Claude Code places its native binary in
`postinstall`, so `npm install -g` can report success and still leave a command
that cannot run. Separately, npm may resolve a platform-specific build that
declares no command at all. Those need different fixes, so they are reported
differently:

```text
  Claude Code: installed but broken
      its native binary is missing, which is what a blocked postinstall script leaves behind
      fix: npm install -g @anthropic-ai/claude-code --allow-scripts=@anthropic-ai/claude-code

  Codex: installed but not on PATH
      npm linked no codex command for this build; the binary itself is at ...\vendor\...\bin\codex.exe
      fix: run it from that path, or reinstall with: npm install -g @openai/codex@latest
```

To write the report to a file instead:

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
