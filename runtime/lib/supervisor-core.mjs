import { createHash, timingSafeEqual } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";

export const LOOPBACK_ADDRESS = "127.0.0.1";

export function assertLoopbackAddress(address) {
  if (address !== LOOPBACK_ADDRESS) {
    throw new Error(`Refusing non-loopback address: ${String(address)}`);
  }
  return address;
}

export function validatePort(value, name = "port") {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`${name} must be an integer from 1024 through 65535`);
  }
  return port;
}

export function boundedInteger(value, name, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(
      `${name} must be an integer from ${minimum} through ${maximum}`,
    );
  }
  return number;
}

export function constantTimeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") {
    return false;
  }
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  if (leftBytes.length !== rightBytes.length) {
    return false;
  }
  return timingSafeEqual(leftBytes, rightBytes);
}

export function requestApiKey(headers) {
  const header = headers["x-api-key"];
  if (typeof header === "string" && header.length > 0) {
    return header;
  }
  const authorization = headers.authorization;
  if (typeof authorization !== "string") {
    return "";
  }
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1] ?? "";
}

export function isAllowedApiPath(urlValue) {
  let pathname;
  try {
    pathname = new URL(urlValue, "http://127.0.0.1").pathname;
  } catch {
    return false;
  }
  return /^\/(?:[A-Za-z0-9._-]+\/)?v1\/(?:models|messages(?:\/count_tokens)?|responses|chat\/completions|embeddings)\/?$/.test(
    pathname,
  );
}

export function isAllowedOrigin(origin) {
  if (!origin) {
    return true;
  }
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      (parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "localhost" ||
        parsed.hostname === "[::1]" ||
        parsed.hostname === "::1")
    );
  } catch {
    return false;
  }
}

export class TokenBucket {
  constructor({ requestsPerMinute, burst, now = () => Date.now() }) {
    this.capacity = boundedInteger(burst, "limits.burst", 1, 100);
    this.requestsPerMinute = boundedInteger(
      requestsPerMinute,
      "limits.requestsPerMinute",
      1,
      600,
    );
    this.refillPerMillisecond = this.requestsPerMinute / 60_000;
    this.tokens = this.capacity;
    this.now = now;
    this.lastRefill = now();
  }

  take() {
    const now = this.now();
    const elapsed = Math.max(0, now - this.lastRefill);
    this.tokens = Math.min(
      this.capacity,
      this.tokens + elapsed * this.refillPerMillisecond,
    );
    this.lastRefill = now;
    if (this.tokens < 1) {
      const missing = 1 - this.tokens;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil(missing / this.refillPerMillisecond / 1000),
        ),
      };
    }
    this.tokens -= 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

export function restartDelayMilliseconds(
  attempt,
  initialDelay,
  maximumDelay,
  random = Math.random,
) {
  const exponent = Math.max(0, Math.min(30, attempt));
  const base = Math.min(maximumDelay, initialDelay * 2 ** exponent);
  const jitter = 0.8 + Math.max(0, Math.min(1, random())) * 0.4;
  return Math.max(0, Math.round(base * jitter));
}

export function redactText(value, knownSecrets = []) {
  let output = String(value);
  for (const secret of knownSecrets) {
    if (typeof secret === "string" && secret.length >= 8) {
      output = output.replaceAll(secret, "[REDACTED]");
    }
  }
  return output
    .replace(
      /\b(Bearer|token|api[-_ ]?key|x-api-key|authorization)\s*[:=]\s*["']?[^"'\s,;]+/gi,
      "$1=[REDACTED]",
    )
    .replace(/\b(gh[opsu]_[A-Za-z0-9_]{20,})\b/g, "[REDACTED]")
    .replace(
      /([?&](?:access_token|api_key|token|key)=)[^&\s]+/gi,
      "$1[REDACTED]",
    );
}

export function safePathname(urlValue) {
  try {
    return new URL(urlValue, "http://127.0.0.1").pathname;
  } catch {
    return "[invalid-url]";
  }
}

export function responseHash(value) {
  return createHash("sha256").update(value).digest("hex");
}

export class JsonlLogger {
  constructor({
    file,
    maximumFileBytes = 5 * 1024 * 1024,
    retainedFiles = 5,
    knownSecrets = [],
  }) {
    this.file = file;
    this.maximumFileBytes = boundedInteger(
      maximumFileBytes,
      "logging.maximumFileBytes",
      64 * 1024,
      100 * 1024 * 1024,
    );
    this.retainedFiles = boundedInteger(
      retainedFiles,
      "logging.retainedFiles",
      1,
      20,
    );
    this.knownSecrets = knownSecrets;
  }

  write(level, event, fields = {}) {
    const safeFields = {};
    for (const [key, value] of Object.entries(fields)) {
      if (/secret|token|authorization|api.?key/i.test(key)) {
        safeFields[key] = "[REDACTED]";
      } else if (typeof value === "string") {
        safeFields[key] = redactText(value.slice(0, 65_536), this.knownSecrets);
      } else {
        safeFields[key] = value;
      }
    }
    const line = `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      component: "supervisor",
      event,
      ...safeFields,
    })}\n`;
    this.#rotateIfNeeded(Buffer.byteLength(line));
    appendFileSync(this.file, line, { encoding: "utf8", mode: 0o600 });
  }

  #rotateIfNeeded(incomingBytes) {
    if (
      !existsSync(this.file) ||
      statSync(this.file).size + incomingBytes <= this.maximumFileBytes
    ) {
      return;
    }
    const oldest = `${this.file}.${this.retainedFiles}`;
    if (existsSync(oldest)) {
      rmSync(oldest, { force: true });
    }
    for (let index = this.retainedFiles - 1; index >= 1; index -= 1) {
      const source = `${this.file}.${index}`;
      const destination = `${this.file}.${index + 1}`;
      if (existsSync(source)) {
        renameSync(source, destination);
      }
    }
    renameSync(this.file, `${this.file}.1`);
  }
}

export function resolveInside(parent, relativePath) {
  if (typeof relativePath !== "string" || path.isAbsolute(relativePath)) {
    throw new Error("Release entrypoint must be a relative path");
  }
  const root = path.resolve(parent);
  const resolved = path.resolve(root, relativePath);
  const comparisonRoot = `${root.toLowerCase()}${path.sep}`;
  if (
    resolved.toLowerCase() !== root.toLowerCase() &&
    !resolved.toLowerCase().startsWith(comparisonRoot)
  ) {
    throw new Error("Release entrypoint escapes the immutable version");
  }
  return resolved;
}
