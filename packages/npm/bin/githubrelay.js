#!/usr/bin/env node
import { writeFileSync } from "node:fs";

import { PACKAGE_NAME, PRODUCT_NAME, packageVersion, runGateway, runGatewayWatched } from "../lib/environment.mjs";
import { buildDoctorReport } from "../lib/doctor.mjs";
import { createDeviceLoginWatcher } from "../lib/device-login.mjs";
import { createDesktopShortcut } from "../lib/shortcut.mjs";
import { ensureGatewayCurrent } from "../lib/gateway-sync.mjs";
import { linkUnlinkedAgents } from "../lib/agents.mjs";
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
  const install = runGateway("install", args);
  if (install.error || install.status !== 0) {
    fail("\nGateway install failed. Run 'githubrelay doctor' and share the output.");
  }

  step(3, total, "Signing in to GitHub");
  const auth = await signIn();
  if (auth.error || auth.status !== 0) {
    fail("\nSign-in failed or was cancelled. Re-run: githubrelay auth");
  }

  // The gateway must be running before clients are configured: client setup
  // discovers the model list from the loopback endpoint, which does not exist
  // until the gateway is up.
  step(4, total, "Starting the gateway");
  const start = runGateway("start");
  if (start.error || start.status !== 0) {
    fail("\nThe gateway did not start. Run 'githubrelay doctor' and share the output.");
  }

  step(5, total, "Configuring your clients");
  // An agent whose command npm never linked looks absent to client
  // configuration, so link it first.
  for (const entry of linkUnlinkedAgents()) {
    console.log(`  linked ${entry.command}`);
  }
  // -SetDefault also selects the relay as the active provider. Without it
  // Codex keeps its own provider and calls api.openai.com, which fails with
  // 401 even though the relay is running and configured.
  const clients = runGateway("configure-clients", ["-Clients", "all", "-SetDefault"]);
  if (clients.error || clients.status !== 0) {
    console.error("Client configuration failed. Re-run with: githubrelay clients");
  }

  const shortcut = createDesktopShortcut();

  console.log(`\n${PRODUCT_NAME} is ready.`);
  console.log("It starts automatically when you sign in to Windows.");
  console.log("\nOpen a new terminal and run 'claude' or 'codex' to use it.");
  if (shortcut.ok) {
    console.log("\nInstalled a coding agent later? Run the desktop shortcut");
    console.log("'Connect coding agents to GitHub Relay', or: githubrelay clients");
  } else {
    console.log("\nInstalled a coding agent later? Run: githubrelay clients");
  }
  console.log("If something looks wrong, run: githubrelay doctor");
  process.exit(0);
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
    ensureGatewayCurrent();
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
    case "configure-clients":
      requirePreflight();
      for (const entry of linkUnlinkedAgents()) {
        console.log(`linked ${entry.command} -> ${entry.path}`);
      }
      return passThrough("configure-clients", args.length > 0 ? args : ["-Clients", "all", "-SetDefault"]);
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
