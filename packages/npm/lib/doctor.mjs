import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { PACKAGE_NAME, PRODUCT_NAME, isWindows, packageVersion, runGateway, runGatewayJson } from "./environment.mjs";
import { formatAgents, inspectAgents } from "./agents.mjs";
import { parseGatewayVersion } from "./gateway-sync.mjs";
import { formatPreflight, runPreflight } from "./preflight.mjs";

const SECRET_KEY_PATTERN = /(key|secret|token|password|authorization|credential|cookie)/i;
const SECRET_VALUE_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9]{16,}/g,
  /\b[A-Fa-f0-9]{32,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];
// PowerShell colourises errors; the codes are noise in a pasted report.
const ANSI_PATTERN = /\u001B\[[0-9;]*[A-Za-z]/g;
const NOT_INSTALLED_PATTERN = /install-root marker is missing|is not installed at/i;

function scrubText(text) {
  let output = String(text).replace(ANSI_PATTERN, "");
  for (const pattern of SECRET_VALUE_PATTERNS) {
    output = output.replace(pattern, "<redacted>");
  }
  const home = homedir();
  if (home) {
    output = output.split(home).join("~");
  }
  return output;
}

/** Masks by key name first, then sweeps remaining values for secret-shaped text. */
function scrubValue(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(scrubValue);
  if (typeof value === "object") {
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = SECRET_KEY_PATTERN.test(key) ? "<redacted>" : scrubValue(entry);
    }
    return output;
  }
  if (typeof value === "string") return scrubText(value);
  return value;
}

function commandVersion(command, args) {
  const probe = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    shell: isWindows(),
  });
  if (probe.error || probe.status !== 0) return "not found";
  return (probe.stdout ?? "").trim().split("\n")[0];
}

function detectClients() {
  return formatAgents(inspectAgents());
}

function readLogs(tail) {
  const result = runGateway("logs", ["-Tail", String(tail)], { capture: true });
  if (result.error) return `unavailable: ${result.error.message}`;
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return text.length > 0 ? scrubText(text) : "no log output";
}

export function buildDoctorReport({ tail = 60 } = {}) {
  const preflight = runPreflight();
  const sections = [];

  const gatewayStatus = preflight.ok ? runGatewayJson("status") : { ok: false };
  const gatewayRelease = gatewayStatus.ok
    ? (parseGatewayVersion(gatewayStatus.value?.ActiveRelease) ?? "unknown")
    : "not installed";

  sections.push(
    [
      `# ${PRODUCT_NAME} diagnostics`,
      "",
      `generated: ${new Date().toISOString()}`,
      `package:   ${PACKAGE_NAME}@${packageVersion()}`,
      `gateway:   ${gatewayRelease}`,
      `node:      ${process.version}`,
      `npm:       ${commandVersion("npm", ["--version"])}`,
      `platform:  ${process.platform}-${process.arch}`,
    ].join("\n"),
  );

  sections.push(["## Preflight", "", formatPreflight(preflight)].join("\n"));

  if (preflight.ok) {
    // Reuses the status already fetched for the header rather than spawning
    // PowerShell a second time.
    const status = gatewayStatus;
    const notInstalled = !status.ok && NOT_INSTALLED_PATTERN.test(status.error ?? "");

    if (notInstalled) {
      sections.push(
        [
          "## Gateway status",
          "",
          "The gateway is not installed yet.",
          "",
          "Run `githubrelay setup` to install it, sign in to GitHub, and configure your clients.",
        ].join("\n"),
      );
    } else {
      sections.push(
        ["## Gateway status", "", "```json", JSON.stringify(scrubValue(status.ok ? status.value : { error: scrubText(status.error) }), null, 2), "```"].join("\n"),
      );

      const health = runGatewayJson("health");
      sections.push(
        ["## Gateway health", "", "```json", JSON.stringify(scrubValue(health.ok ? health.value : { error: scrubText(health.error) }), null, 2), "```"].join("\n"),
      );

      sections.push(["## Recent logs", "", "```", readLogs(tail), "```"].join("\n"));
    }
  } else {
    sections.push(
      ["## Gateway status", "", "Skipped because preflight failed. Fix the items above first."].join("\n"),
    );
  }

  sections.push(["## Coding agents", "", detectClients()].join("\n"));

  sections.push(
    [
      "---",
      "",
      "Secrets are redacted before this report is produced. Review it once before sharing.",
    ].join("\n"),
  );

  return sections.join("\n\n");
}

export { scrubText, scrubValue };
