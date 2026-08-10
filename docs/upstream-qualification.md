# Upstream qualification

Research cutoff: **2026-08-10**

## Selected backend

| Field | Pinned value |
|---|---|
| Package | `@jeffreycao/copilot-api` |
| Version | `2.0.1` |
| Repository | `caozhiyuan/copilot-api` |
| Git commit | `590bc1473e224dbb2d588d3cfb475f823de3ad74` |
| npm SHA-512 | `sha512-yY0nuj65kY5OlFT+wlss0VI+rYu3NFD1sXyj6uEGdQiH2a0mqYWd2MGrC0f3JPRUG4yRVpcvtcix5TjABv5AgA==` |
| npm SHA-1 | `281e3574f33d95039b02082f6393aa1c89e9a553` |
| License | MIT |
| Node engine | `>=20`; this wrapper requires `>=22.13.0` |

The npm package was published by GitHub Actions trusted publishing with npm
provenance. The GitHub tag/release itself is mutable/unsigned, so installation
trust is based on the exact npm version, committed dependency graph, npm SRI,
and installed-content checks rather than a tag name alone.

The package has semver-ranged transitive dependencies and no npm shrinkwrap.
Calling `npx @jeffreycao/copilot-api@2.0.1` would pin only the top-level
tarball, not the dependency graph. This repository commits lockfile version 3
and installs with `npm ci`.

## Why this fork

`caozhiyuan/copilot-api` was actively maintained at the research cutoff and
describes itself as the independent continuation of `ericc-ch/copilot-api`.
The selected release includes:

- OpenAI Responses
- OpenAI Chat Completions
- Anthropic Messages and token counting
- dynamic `/v1/models`
- provider-prefixed routes
- local API keys and a distinct admin key
- fixed data-home support through `COPILOT_API_HOME`

The stale `ericc-ch` upstream's last package/release was 0.7.0 from 2025-10-05.
It is not the primary dependency.

## Verified upstream behavior

- CLI bin: `node_modules/@jeffreycao/copilot-api/dist/main.js`
- Auth: `auth login --provider copilot`
- Start: `start --port PORT`
- Persistent root: `COPILOT_API_HOME`
- Host selection: `HOST`; it must be explicitly set to `127.0.0.1`
- Handler logs: `COPILOT_API_LOG_DIR`
- SQLite path: `COPILOT_API_SQLITE_DB_PATH`
- API authentication: `auth.apiKeys`
- Admin authentication: `auth.adminApiKey`
- Empty `apiKeys` means ordinary routes are unauthenticated
- `/token` returns the active Copilot bearer token when reachable/authenticated
- No built-in rate limit or concurrency limit
- No built-in TLS option
- Verbose mode can log request/translated payloads

The wrapper therefore:

1. Pre-creates the upstream auth configuration while stopped.
2. Uses separate internal and admin secrets.
3. Places a public authenticated/rate-limited loopback proxy in front.
4. Blocks `/token` and `/admin` at the public boundary.
5. Forces `HOST=127.0.0.1` and verifies non-loopback reachability fails.
6. Never enables verbose/token-display flags.

## Protocol caveats

Translation is model-dependent. Upstream prefers native Messages, then
Responses, then Chat translation. This is not complete OpenAI/Anthropic
conformance. Known risk areas include:

- filtered Anthropic beta flags
- estimated token counting without a separate Anthropic key
- PDF/rich tool-result downgrade on Chat fallback
- unsupported image-generation/web-search combinations
- potential reasoning-signature continuity loss on some translated Claude
  fallback paths
- model-specific Responses behavior under concurrent long sessions

The wrapper deliberately does not alter or retry inference traffic.

## License

The upstream MIT license permits private use and redistribution but requires
the copyright and permission notice to remain with substantial copies. The
text is retained in `licenses/copilot-api-MIT.txt`.

The software license does not grant rights to GitHub's service or trademarks.
GitHub terms and Acceptable Use Policies independently govern Copilot use.

## Requalification checklist

Before changing the pin:

1. Require an exact published npm version and canonical SRI.
2. Verify repository/tag/commit provenance and release CI.
3. Inspect CLI, auth/config schema, bind behavior, routes, logging, and license.
4. Generate a fresh lock and install with lifecycle scripts disabled.
5. Run all fake-backend tests.
6. Run an opt-in private live contract test for Messages, Responses, tools,
   streaming, model discovery, and token refresh.
7. Verify public and internal listeners are loopback-only.
8. Exercise forward update and rollback with a copied backend data directory.
