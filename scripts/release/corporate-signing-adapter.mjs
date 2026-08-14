import { spawn } from "node:child_process";
import path from "node:path";

const [operation, input, output, artifactClass] = process.argv.slice(2);
if (!["sign", "verify"].includes(operation)) {
  throw new Error("Operation must be sign or verify.");
}
if (!["windows", "macos", "linux", "manifest"].includes(artifactClass)) {
  throw new Error("Artifact class is invalid.");
}
if (!input) {
  throw new Error("An input path is required.");
}
if (operation === "sign" && !output) {
  throw new Error("Signing requires an output path.");
}

const client = process.env.MODEL_RELAY_SIGNING_CLIENT;
if (!client || !path.isAbsolute(client)) {
  throw new Error(
    "MODEL_RELAY_SIGNING_CLIENT must be an absolute protected-environment path.",
  );
}
if (!/^model-relay-corporate-signing-client(?:\.exe)?$/i.test(path.basename(client))) {
  throw new Error("Corporate signing client executable name is not allowlisted.");
}

const arguments_ = [
  operation,
  "--input",
  path.resolve(input),
  ...(operation === "sign" ? ["--output", path.resolve(output)] : []),
  "--class",
  artifactClass,
  "--oidc-audience",
  "github-model-relay-signing",
];

const code = await new Promise((resolve, reject) => {
  const child = spawn(client, arguments_, {
    shell: false,
    windowsHide: true,
    stdio: "inherit",
    env: {
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
      ACTIONS_ID_TOKEN_REQUEST_URL: process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
      CI: process.env.CI,
    },
  });
  child.once("error", reject);
  child.once("exit", resolve);
});
if (code !== 0) {
  throw new Error(`Corporate signing adapter exited with ${code}.`);
}
