import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { isWindows, resolvePowerShell } from "./environment.mjs";

export const SHORTCUT_NAME = "Connect coding agents to GitHub Relay";

/**
 * Creates a desktop shortcut that re-runs client configuration.
 *
 * The gateway itself starts at logon through a scheduled task, so this is not
 * a launcher. It exists for the one action a user needs after installing a new
 * coding agent: point that agent at the relay.
 *
 * The Desktop path is resolved by Windows rather than assumed to be
 * %USERPROFILE%\Desktop, because OneDrive Known Folder Move relocates it and
 * the original path then does not exist at all.
 */
export function createDesktopShortcut() {
  if (!isWindows()) return { ok: false, reason: "Windows only" };

  const shell = resolvePowerShell();
  if (!shell) return { ok: false, reason: "PowerShell not found" };

  // Launch through the npm shim so the shortcut survives launcher upgrades.
  const launcher = join(process.env.APPDATA ?? "", "npm", "githubrelay.cmd");
  if (!existsSync(launcher)) return { ok: false, reason: "githubrelay command not found" };

  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$desktop = [Environment]::GetFolderPath('Desktop')",
    "if ([string]::IsNullOrWhiteSpace($desktop) -or -not (Test-Path -LiteralPath $desktop)) { throw 'Desktop folder not found' }",
    `$target = Join-Path $desktop ${JSON.stringify(`${SHORTCUT_NAME}.lnk`)}`,
    "$shell = New-Object -ComObject WScript.Shell",
    "$link = $shell.CreateShortcut($target)",
    `$link.TargetPath = ${JSON.stringify(launcher)}`,
    '$link.Arguments = "clients -Clients all -SetDefault"',
    '$link.Description = "Point Claude Code, Codex, OpenCode and Pi at GitHub Model Relay"',
    "$link.WorkingDirectory = $desktop",
    "$link.Save()",
    "Write-Output $target",
  ].join("; ");

  const result = spawnSync(shell.command, ["-NoProfile", "-NonInteractive", "-Command", script], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });

  if (result.error || result.status !== 0) {
    const reason = (result.stderr || result.error?.message || "unknown error").trim().split("\n")[0];
    return { ok: false, reason };
  }
  return { ok: true, path: (result.stdout ?? "").trim() };
}
