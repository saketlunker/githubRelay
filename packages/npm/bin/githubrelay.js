#!/usr/bin/env node
import { writeFileSync } from "node:fs";

import { PACKAGE_NAME, PRODUCT_NAME, packageVersion, runGateway, runGatewayJson, runGatewayWatched } from "../lib/environment.mjs";
import { buildDoctorReport } from "../lib/doctor.mjs";
import { createDeviceLoginWatcher } from "../lib/device-login.mjs";
import { createDesktopShortcut } from "../lib/shortcut.mjs";
import { ensureGatewayCurrent } from "../lib/gateway-sync.mjs";
import { CLAUDE_CODE_INSTALL, CODEX_INSTALL, agentInstallCommand, inspectAgents, linkUnlinkedAgents } from "../lib/agents.mjs";
import { failureTail, parseConfigureOutput, releaseIdFrom, summarizeConfiguration } from "../lib/setup-summary.mjs";
import { formatPreflight, runPreflight } from "../lib/preflight.mjs";
import { checkForUpdate } from "../lib/update.mjs";

const HELP = `${PRODUCT_NAME} (${PACKAGE_NAME})

Usage: githubrelay <command> [options]

Getting started
  setup              Install, sign in to GitHub, wire up your clients, and start
  doctor             Print a redacted diagnostic report you can share for support
Everyday use
  status             Show gateway status
  health             Run a health check
  logs [-Tail 200]   Show recent gateway logs
  models [list|refresh|set-alias]
  start | stop | restart

Maintenance
  auth               Re-run GitHub device sign-in
  clients            Re-apply Claude Code / Codex / OpenCode / Pi configuration
  shortcut           Recreate the desktop shortcut for re-linking agents
  update             Update the installed gateway release
  uninstall          Remove the gateway
  version            Print the installed version

Choosing models and reasoning (remembered for later re-links)
  githubrelay clients -OpusModel claude-opus-5-5 -SonnetModel claude-sonnet-5
  githubrelay clients -CodexModel gpt-6-astra
  githubrelay clients -ClaudeEffort xhigh -CodexEffort max
  Effort is one of: low, medium, high, xhigh, max, default
  Defaults: Claude xhigh (change it in a session with /effort), Codex max

Environment
  GITHUBRELAY_DISABLE_AUTO_UPDATE=1   Never check for launcher updates
  GITHUBRELAY_OFFLINE=1               Skip all network calls at startup
`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function requirePreflight() {
  const preflight = runPreflight();
  if (!preflight.ok) {
    console.error(`${PRODUCT_NAME} cannot run yet:\n`);
    console.error(formatPreflight(preflight));
    console.error("\nFix the items marked [!!] above, then run: githubrelay setup");
    process.exit(1);
  }
}

function passThrough(command, args, { interactive = false } = {}) {
  const result = runGateway(command, args, { interactive });
  if (result.error) fail(result.error.message);
  process.exit(result.status ?? 0);
}

function step(number, total, title) {
  console.log(`\n[${number}/${total}] ${title}`);
}

async function signIn() {
  console.log("A device code will appear below. It is copied to your clipboard automatically.\n");
  return runGatewayWatched("authenticate", [], { onLine: createDeviceLoginWatcher({ announce: console.log }) });
}

function gatewayServing() {
  const status = runGatewayJson("status");
  return status.ok && status.value?.Health === "ready";
}

function agentAdvice() {
  const lines = [];
  for (const [name, entry] of Object.entries(inspectAgents())) {
    if (entry.status === "ready" || (entry.status === "not installed" && !["Claude Code", "Codex"].includes(name))) {
      continue;
    }
    if (entry.status === "not installed") {
      const install = name === "Claude Code"
        ? CLAUDE_CODE_INSTALL
        : name === "Codex"
          ? CODEX_INSTALL
          : agentInstallCommand(entry.agent.packageName);
      lines.push(`  ${name} is not installed. Install it with:`, `    ${install}`, "  then run: githubrelay clients");
      continue;
    }
    lines.push(`  ${name}: ${entry.status}`);
    if (entry.detail) lines.push(`    ${entry.detail}`);
    if (entry.fix) lines.push(`    fix: ${entry.fix}`);
  }
  return lines;
}

async function setup(args) {
  const total = 5;
  console.log(`Setting up ${PRODUCT_NAME}.\n`);

  step(1, total, "Checking prerequisites");
  const preflight = runPreflight();
  console.log(formatPreflight(preflight));
  if (!preflight.ok) {
    console.error("\nSetup stopped. Fix the items marked [!!] above and run: githubrelay setup");
    process.exit(1);
  }

  step(2, total, "Installing the gateway");
  const install = runGateway("install", args, { capture: true });
  if (install.error || install.status !== 0) {
    for (const line of failureTail(install)) console.error(`  ${line}`);
    fail("\nGateway install failed. Run 'githubrelay doctor' and share the output.");
  }
  console.log(`  Installed ${releaseIdFrom(`${install.stdout ?? ""}`) ?? "the gateway"}.`);

  // Re-running setup on a working install must not force a new device
  // sign-in: the running relay proves the stored credential still works.
  const alreadyServing = gatewayServing();

  step(3, total, "Signing in to GitHub");
  if (alreadyServing) {
    console.log("  Already signed in; the relay is serving requests.");
  } else {
    const auth = await signIn();
    if (auth.error || auth.status !== 0) {
      fail("\nSign-in failed or was cancelled. Re-run: githubrelay auth");
    }
  }

  // The gateway must be running before clients are configured: client setup
  // discovers the model list from the loopback endpoint. On a re-run the new
  // release only takes effect after a restart; "start" would keep the old one.
  step(4, total, alreadyServing ? "Restarting the gateway" : "Starting the gateway");
  const start = runGateway(alreadyServing ? "restart" : "start", [], { capture: true });
  if (start.error || start.status !== 0) {
    for (const line of failureTail(start)) console.error(`  ${line}`);
    fail("\nThe gateway did not start. Run 'githubrelay doctor' and share the output.");
  }
  const endpoint = /https?:\/\/127\.0\.0\.1:\d+/.exec(`${start.stdout ?? ""}`)?.[0];
  console.log(endpoint ? `  Running on ${endpoint}.` : "  Running.");

  step(5, total, "Configuring your coding agents");
  // An agent whose command npm never linked looks absent to client
  // configuration, so link it first.
  for (const entry of linkUnlinkedAgents()) {
    console.log(`  linked ${entry.command}`);
  }
  // -SetDefault also selects the relay as the active provider. Without it
  // Codex keeps its own provider and calls api.openai.com, which fails with
  // 401 even though the relay is running and configured.
  const clients = runGateway("configure-clients", ["-Clients", "all", "-SetDefault"], { capture: true });
  const clientsConfigured = !clients.error && clients.status === 0;
  if (clientsConfigured) {
    const summary = parseConfigureOutput(`${clients.stdout ?? ""}`);
    for (const line of summarizeConfiguration(summary)) console.log(line);
  } else {
    for (const line of failureTail(clients)) console.error(`  ${line}`);
    console.error("\nAgent configuration failed. Run 'githubrelay doctor' and share the output.");
  }

  const shortcut = createDesktopShortcut();
  const advice = agentAdvice();

  console.log(clientsConfigured
    ? `\n${PRODUCT_NAME} is ready.`
    : `\n${PRODUCT_NAME} is running, but your coding agents still need attention.`);
  console.log("It starts automatically when you sign in to Windows.");
  if (advice.length > 0) {
    console.log("\nBefore you start:");
    for (const line of advice) console.log(line);
  }
  console.log("\nOpen a new terminal and run 'claude' or 'codex' to use it.");
  if (shortcut.ok) {
    console.log("\nInstalled a coding agent later? Run the desktop shortcut");
    console.log("'Connect coding agents to GitHub Relay', or: githubrelay clients");
  } else {
    console.log("\nInstalled a coding agent later? Run: githubrelay clients");
  }
  console.log("If something looks wrong, run: githubrelay doctor");
  process.exit(clientsConfigured ? 0 : 1);
}

function doctor(args) {
  const report = buildDoctorReport({ tail: 60 });
  const outIndex = args.findIndex((value) => value === "--out" || value === "-o");
  if (outIndex !== -1 && args[outIndex + 1]) {
    writeFileSync(args[outIndex + 1], report, "utf8");
    console.log(`Diagnostics written to ${args[outIndex + 1]}`);
  } else {
    console.log(report);
  }
  process.exit(0);
}

async function main() {
  const [command = "help", ...args] = process.argv.slice(2);

  if (command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
    return;
  }
  if (command === "version" || command === "--version" || command === "-v") {
    console.log(`${PACKAGE_NAME} ${packageVersion()}`);
    return;
  }

  await checkForUpdate();

  // The launcher updates itself from npm, but the gateway is a separate
  // release on disk. Bringing it along automatically is the whole point of
  // shipping a fix: a user should not have to know an update exists.
  // Excluded are commands that report state or deliberately change it, which
  // must not have the gateway swapped underneath them.
  if (!["doctor", "uninstall", "update", "rollback", "stop", "shortcut", "setup"].includes(command)) {
    // `clients` re-links on its own right after, with the user's own flags.
    ensureGatewayCurrent({ relink: !["clients", "configure-clients"].includes(command) });
  }

  switch (command) {
    case "setup":
      return setup(args);
    case "doctor":
      return doctor(args);
    case "auth":
    case "authenticate": {
      requirePreflight();
      const result = await signIn();
      if (result.error) fail(result.error.message);
      process.exit(result.status ?? 0);
      return undefined;
    }
    case "clients":
    case "configure-clients": {
      requirePreflight();
      for (const entry of linkUnlinkedAgents()) {
        console.log(`linked ${entry.command} -> ${entry.path}`);
      }
      // Re-linking always selects the relay as the default provider, even
      // when a model or effort is also given: without -SetDefault, Codex keeps
      // its own provider and a chosen default model is never applied.
      const forwarded = args.some((value) => value.toLowerCase() === "-setdefault")
        ? args
        : [...args, "-SetDefault"];
      return passThrough("configure-clients", forwarded);
    }
    case "shortcut": {
      const created = createDesktopShortcut();
      if (created.ok) {
        console.log(`Created ${created.path}`);
        process.exit(0);
      }
      fail(`Could not create the shortcut: ${created.reason}`);
      return undefined;
    }
    case "status":
    case "health":
    case "logs":
    case "models":
    case "start":
    case "stop":
    case "restart":
    case "update":
    case "rollback":
    case "uninstall":
      requirePreflight();
      return passThrough(command, args);
    default:
      console.error(`Unknown command: ${command}\n`);
      console.error(HELP);
      process.exit(1);
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
