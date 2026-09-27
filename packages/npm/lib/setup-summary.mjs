/**
 * Turns the gateway's machine-readable output into a few lines a person can
 * read. Setup used to print raw JSON and PowerShell object tables, which read
 * as noise to someone who just wants to know that it worked.
 */

const LABELS = Object.freeze({
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  pi: "Pi",
});

/** The JSON object in a configure-clients run's output, if there is one. */
export function parseConfigureOutput(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return undefined;
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

export function summarizeConfiguration(result) {
  const effort = (value) => (value && value !== "default" ? `, reasoning ${value}` : "");
  const lines = [];
  for (const client of result?.clients ?? []) {
    const label = (LABELS[client.client] ?? client.client).padEnd(12);
    if (client.installation === "not-installed") {
      lines.push(`  ${label}not installed; ready for when you install it`);
    } else if (client.client === "claude") {
      lines.push(
        `  ${label}${result.models.claude} (Sonnet slot: ${result.models.sonnet})${effort(result.effort?.claude)}`,
      );
    } else if (client.client === "codex") {
      lines.push(`  ${label}${result.models.codex}${effort(result.effort?.codex)}`);
    } else {
      lines.push(`  ${label}linked`);
    }
  }
  return lines;
}

/** The release id from install or start output, e.g. gateway-0.4.0-backend-2.0.1-ab12. */
export function releaseIdFrom(text) {
  return /\bgateway-\d+\.\d+\.\d+[\w.-]*/.exec(text)?.[0];
}

/** The last meaningful lines of a failed step, which usually name the cause. */
export function failureTail(result, lines = 15) {
  return `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .slice(-lines);
}
