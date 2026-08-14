import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv.includes("auth")) {
  process.exit(7);
}

const port = Number(argumentValue("--port"));
if (!Number.isInteger(port)) {
  throw new Error("Fake backend requires --port");
}
const host = process.env.HOST ?? "0.0.0.0";
const home = process.env.COPILOT_API_HOME;
const config = JSON.parse(
  readFileSync(path.join(home, "config.json"), "utf8"),
);
const apiKeys = new Set(config.auth?.apiKeys ?? []);

function authorized(request) {
  const xApiKey = request.headers["x-api-key"];
  const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? "")?.[1];
  return apiKeys.has(xApiKey) || apiKeys.has(bearer);
}

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  if (pathname === "/") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("Server running");
    return;
  }
  if (!authorized(request)) {
    response.writeHead(401, { "content-type": "application/json" });
    response.end('{"error":"unauthorized"}');
    return;
  }
  if (pathname === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        object: "list",
        data: [
          { id: "claude-sonnet-test", object: "model" },
          { id: "gpt-codex-test", object: "model" },
        ],
      }),
    );
    return;
  }
  if (pathname === "/token") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"token":"UPSTREAM_TOKEN_SHOULD_NEVER_ESCAPE"}');
    return;
  }
  if (pathname === "/v1/messages") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      const delay = Number(request.headers["x-test-delay"] ?? 0);
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, receivedBytes: body.length }));
      }, delay);
    });
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end('{"error":"not_found"}');
});

server.listen(port, host);

function stop() {
  server.close(() => process.exit(0));
}

process.on("SIGTERM", stop);
process.on("SIGINT", stop);
