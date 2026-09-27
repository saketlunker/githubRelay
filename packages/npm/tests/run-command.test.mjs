import assert from "node:assert/strict";
import { test } from "node:test";

import { cmdCommandLine, runCommandSync } from "../lib/environment.mjs";

test("cmd command lines quote only what cmd.exe would split or interpret", () => {
  assert.equal(cmdCommandLine("npm", ["--version"]), "npm --version");
  assert.equal(
    cmdCommandLine("C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\claude.cmd", ["--version"]),
    '"C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\claude.cmd" --version',
  );
  assert.equal(cmdCommandLine("C:\\Program Files (x86)\\tool.cmd"), '"C:\\Program Files (x86)\\tool.cmd"');
  assert.equal(cmdCommandLine("npm"), "npm");
});

test("running a command prints no DEP0190 deprecation warning", async () => {
  const warnings = [];
  const listener = (warning) => warnings.push(warning);
  process.on("warning", listener);
  try {
    // node.exe usually lives under "Program Files", so on Windows this also
    // proves a path with spaces survives the trip through cmd.exe.
    const result = runCommandSync(process.execPath, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), process.version);
    // Warnings are emitted on a later tick.
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("warning", listener);
  }

  assert.deepEqual(
    warnings.filter((warning) => warning.code === "DEP0190").map((warning) => warning.message),
    [],
  );
});
