import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { app } from "electron";

function desktopEscape(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export async function setLaunchAtLogin(enabled: boolean) {
  if (process.platform === "win32" || process.platform === "darwin") {
    app.setLoginItemSettings({
      name: "GitHub Model Relay",
      openAtLogin: enabled,
      args: enabled ? ["--hidden"] : [],
    });
    return;
  }
  if (process.platform !== "linux") {
    throw new Error(`Launch at login is unsupported on ${process.platform}.`);
  }
  const home = process.env.HOME;
  if (!home) {
    throw new Error("HOME is unavailable.");
  }
  const directory = path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"),
    "autostart",
  );
  const target = path.join(directory, "github-model-relay.desktop");
  if (!enabled) {
    await rm(target, { force: true });
    return;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const executable = desktopEscape(process.execPath);
  await writeFile(
    target,
    [
      "[Desktop Entry]",
      "Type=Application",
      "Name=GitHub Model Relay",
      `Exec="${executable}" --hidden`,
      "Terminal=false",
      "X-GNOME-Autostart-enabled=true",
      "Comment=Unofficial local model relay for coding tools",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o600 },
  );
}
