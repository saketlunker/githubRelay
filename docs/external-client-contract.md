# External native client contract

This is the contract for an **original client of an already installed Relay**,
not an embedded Copilot implementation. Relay is unofficial and is not
affiliated with or endorsed by GitHub. A software license does not grant
Copilot service access.

## Exact sources and qualification

| Component | Pin |
| --- | --- |
| Relay source / package version | `94e8a9e375f572c80f4ff2c5271a9c435d831e64` / `0.3.1` |
| Backend package | `@jeffreycao/copilot-api@2.0.1` |
| Backend source | `590bc1473e224dbb2d588d3cfb475f823de3ad74` |
| Backend lock integrity | `sha512-yY0nuj65kY5OlFT+wlss0VI+rYu3NFD1sXyj6uEGdQiH2a0mqYWd2MGrC0f3JPRUG4yRVpcvtcix5TjABv5AgA==` |

On 2026-09-16 IST, the installed supervisor and core matched these Relay
sources after CRLF/LF normalization. All 30 installed backend package files
matched the previously retained exact-package evidence. That earlier evidence
matched 110 source-map inputs to the backend commit; it did not independently
verify the canonical npm tarball SRI or publishing attestation.

The only live API checks were unauthenticated health and catalog requests:
health returned `200`, `status: "ready"`, `backendReady: true`; models returned
`401`, `{"error":"unauthorized"}`. This proves a running protected listener,
**not an entitled account, an enabled model, a successful completion, or a
fresh-machine installation**. No credentials, process arguments, or process
environment were inspected. No login, model call, update, restart, or client
configuration action was performed.

## Discovery and local authentication

The shipped Windows headless install root is
`%LOCALAPPDATA%\CopilotHarnessGateway`. Custom `-InstallRoot` installations
require an explicit root; there is no discovery/pairing service.

Read only `config\gateway.json` for discovery:

```json
{
  "schemaVersion": 1,
  "listen": { "address": "127.0.0.1", "port": 4141 }
}
```

The configured port must be an integer from 1024 through 65535. The public
address is exactly IPv4 `127.0.0.1`; do not substitute `localhost`, IPv6, LAN,
or the internal backend port, normally `4142`.

| Purpose | Default URL |
| --- | --- |
| Origin | `http://127.0.0.1:4141` |
| OpenAI-compatible API base | `http://127.0.0.1:4141/v1` |
| Health | `GET http://127.0.0.1:4141/_gateway/health` |
| Catalog | `GET http://127.0.0.1:4141/v1/models` |
| Text chat | `POST http://127.0.0.1:4141/v1/chat/completions` |

Every catalog/chat request needs either `Authorization: Bearer <local-key>`
or `x-api-key: <local-key>`. A nonempty `x-api-key` takes precedence over
Authorization. The key is Relay's shared **local client key**, not a GitHub
token, Copilot token, PAT, internal backend key, or administrator key.

The documented generic-client interface is the current user's
`COPILOT_HARNESS_GATEWAY_API_KEY` environment variable. Successful
`configure-clients` sets it; new processes inherit it, existing processes may
not. Relay internally stores the key at `secrets\secrets.json.clientApiKey`.
That location is source documentation, not permission for a client to read it.
The existing Claude helper writes the environment value to its private
subprocess stdout. There is **no supported pairing, per-app registration,
keyring export, or per-client revocation API** at this pin.

A new client must obtain explicit consent for its chosen native credential
handoff. It can use a private OS-owned credential prompt, or an approved,
narrow native import of the documented local environment value. Never route
the value through renderer IPC, argv, URLs, logs, diagnostic exports, terminal
output, or recorded demonstrations. Do not scrape editor configuration or
GitHub credential stores. Scope any app-owned keyring entry to the selected
root and endpoint; changing either must not reuse an unrelated credential.

Use native HTTP with redirects and system proxy use disabled. Send no
`Origin`; non-loopback browser origins are rejected and upstream CORS response
headers are stripped. Use an honest application User-Agent, not a Codex or
editor identity. Do not call the launcher to perform a supposedly read-only
check: several launcher commands also check for updates/synchronize the
installed gateway.

## Health is not account status

The unauthenticated health response is:

```json
{
  "status": "ready",
  "backendReady": true,
  "instanceId": "opaque-instance-identifier",
  "activeVersionId": "opaque-release-identifier"
}
```

HTTP status is `200` only for `status == "ready"`, otherwise `503`. Source
states include `starting`, `ready`, `stopping`, `stopped`, `backoff`,
`backend-failed`, `blocked-auth`, `blocked-port`, and `blocked-restart-limit`.
Treat unfamiliar states as not ready, not as signed out.

`blocked-auth` means the supervisor found neither a nonempty persisted GitHub
credential nor an enabled backend provider configuration. It does not mean
"expired login." Conversely, a nonempty expired credential or an enabled
non-Copilot provider can pass that presence check. Do not equate health
readiness with successful Copilot authentication or entitlement.

## Public model catalog

With a normal, non-Codex User-Agent, the response is:

```json
{
  "object": "list",
  "data": [
    {
      "id": "fixture-chat",
      "object": "model",
      "type": "model",
      "created": 0,
      "created_at": "1970-01-01T00:00:00.000Z",
      "name": "Fictional text model",
      "display_name": "Fictional text model",
      "vendor": "fixture",
      "owned_by": "fixture",
      "model_picker_enabled": true,
      "policy": { "state": "enabled", "terms": "Fictional fixture only" },
      "supported_endpoints": ["/chat/completions"],
      "capabilities": {
        "type": "chat",
        "family": "fixture",
        "limits": { "max_output_tokens": 64 },
        "supports": { "streaming": true }
      }
    }
  ],
  "has_more": false
}
```

The example is synthetic, not a live selectable model ID.

Copilot rows preserve backend metadata and add `type`, `created`,
`created_at`, `owned_by`, `display_name`, and `claude_model_id`. Public Claude
IDs are already client-normalized: dotted versions become hyphenated and
date suffixes can disappear. `claude_model_id` gains `[1m]` when the advertised
context window is at least 1,000,000 tokens. **Use the public `id` unchanged**;
do not use `claude_model_id`, invent aliases, or apply the old embedded/raw
Copilot-ID contract. The chat handler only applies configured model mappings;
it does not itself perform the Messages handler's Claude-ID resolution.
Consequently, a listed ID is not proof that chat with that ID will succeed.

Additional enabled providers can contribute `provider/id` rows. Rows are
deduplicated by public ID, not filtered for entitlement. A Codex-like
User-Agent selects a different, synthetic catalog branch. For a Copilot-only
client, exclude provider-prefixed rows and never fall back to another
provider/account. Service-owned model mappings can still change routing;
the public catalog cannot attest the upstream account or final model.

The native endpoint strings in capability metadata are `/chat/completions`,
`/responses`, `/v1/messages`, and `ws:/responses`. For text streaming through
this chat route, require compatible chat/streaming metadata and reject
explicitly disabled models. Missing metadata means unknown, not supported.
Preserve numeric `max_context_window_tokens`, `max_prompt_tokens`, and
`max_output_tokens`; never delete them because their field names contain
`token`. Do not derive raw capabilities from Relay's sanitized CLI cache.

## Chat and streaming

Send UTF-8 JSON with `Content-Type: application/json` and
`Accept: text/event-stream`:

```json
{
  "model": "fixture-chat",
  "messages": [
    { "role": "system", "content": "Reply briefly." },
    { "role": "user", "content": "A synthetic test message." }
  ],
  "stream": true,
  "max_tokens": 64,
  "stream_options": { "include_usage": true }
}
```

`model` and `messages` are required by the backend's payload contract.
Optional token/output limits and sampling parameters are model-dependent.
When neither output limit is provided, the handler uses the model catalog's
output limit if found. For model names containing `gpt`, it moves `max_tokens`
to `max_completion_tokens` unless that field is already present. The Chat
Completions handler does not add Messages/Responses translation for models
that support only those endpoints.

### Response headers and first-text deadlines

A successful TCP connection does not mean chat response headers will arrive
immediately. The backend awaits the remote inference `fetch` before creating
its Hono SSE response. It sends no initial heartbeat. The pinned Node adapter
is `srvx@0.11.22` (`src\start.ts`), with `hono@4.13.1` and
`fetch-event-stream@0.1.6`. The adapter calls `writeHead`, then waits for the
response reader before writing body bytes; it does not call `flushHeaders`.
Relay's public proxy also uses `writeHead` followed by `pipe`, without a
header flush.

On the normal HTTP/1 streaming path, headers can therefore remain buffered
until the first forwarded SSE record or stream end. This is **not necessarily
the first visible text**: a role-only record can release headers. The backend
parser waits for a complete SSE record and discards comment-only heartbeats.

A timeout around a client's entire `send()` future includes waiting for these
headers, not just TCP connection establishment. Use a transport-level connect
timeout, a first-visible-text deadline spanning both sending and reading, and
an independent total deadline. For a client policy of 5/15/120 seconds, keep
the 5 seconds on TCP connect, not around `send()`. Do not restart the 15-second
budget when headers, roles, usage, or non-text events arrive. Test delayed
headers and headers-with-delayed-text separately. This is a static contract
finding, not a measurement of any real request's latency.

### SSE records

The response is SSE, normally with `data: <JSON>` records and a terminal
`data: [DONE]`. A text delta looks like:

```text
data: {"id":"fixture-stream","object":"chat.completion.chunk","created":0,"model":"fixture-chat","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null,"logprobs":null}]}

data: {"id":"fixture-stream","object":"chat.completion.chunk","created":0,"model":"fixture-chat","choices":[{"index":0,"delta":{},"finish_reason":"stop","logprobs":null}]}

data: [DONE]

```

Parse incremental UTF-8 and SSE framing, not one JSON object per socket chunk.
Support CRLF/LF, comment heartbeats, optional SSE fields, and multiple `data:`
lines joined by newline. A role-only delta, `content: null`, or empty
`choices: []` usage record is not output text. Display only
`choices[index].delta.content` for the selected choice. Do not display
`reasoning_text`, `reasoning_content`, `reasoning_opaque`, or tool arguments.

`finish_reason` is null or `stop`, `length`, `tool_calls`, `content_filter`.
Keep token-limit, filtered, and unsupported-tool outcomes distinct from an
ordinary answer. Usage can include prompt/completion/total tokens and
`copilot_usage.total_nano_aiu`. Neither usage presence nor billing fields are
required for a text answer.

The backend forwards SSE events and does not synthesize a missing `[DONE]`.
Require a terminal protocol outcome; EOF without `[DONE]` is a truncated
stream, not successful completion. After a terminal outcome or cancellation,
ignore late events and emit only one client terminal notification. Do not
retry a partially emitted turn automatically.

With `stream: false`, a successful response is OpenAI-shaped
`{id, object:"chat.completion", created, model, choices:[{index, message:
{role:"assistant",content}, finish_reason, logprobs}], usage?}`.

## Errors, limits, and cancellation

| HTTP | Proxy JSON body | Meaning |
| --- | --- | --- |
| 401 | `{"error":"unauthorized"}` | Missing/wrong local client key |
| 403 | `{"error":"origin_not_allowed"}` | Disallowed browser Origin |
| 404 | `{"error":"route_not_exposed"}` | Not a public API route |
| 503 | `{"error":"backend_not_ready"}` | Backend cannot accept the request |
| 429 | `{"error":"rate_limited"}` | Global request bucket exhausted |
| 429 | `{"error":"concurrency_limited"}` | Global active-request limit reached |
| 502 | `{"error":"upstream_error"}` | Backend transport failed before headers |

Proxy errors are **string** envelopes. Backend errors can instead be
`{"error":{"message":"raw upstream response text","type":"error"}}`.
The backend preserves an upstream HTTP error status; ordinary exceptions
become 500. The nested message can contain JSON encoded as a string or unsafe
remote text. Classify locally and redact; do not show/log it verbatim. Unknown
routes/methods can also yield non-JSON backend errors.

Both proxy 429 cases include `Retry-After` in seconds. Concurrency uses `1`;
rate limiting computes the next available token. Upstream 429 can forward
`Retry-After` and `x-*` headers, so diagnostic code should allowlist rather
than copy all response headers.

Defaults are two global concurrent requests, 20 requests/minute, burst four,
and `requestTimeoutMs: 900000`. Catalog traffic shares the bucket with chat;
unauthenticated health does not. The timeout is a Node upstream socket
inactivity timeout, **not a total client deadline**. Set separate bounded
connect/header, idle, and overall deadlines in the client.

There is no public per-request cancel endpoint. Abort the native request and
response reader and fence all late UI callbacks. The supervisor destroys its
backend request when the incoming request emits `aborted`, but on downstream
response `close` it only releases accounting. The backend Copilot fetch and
SSE reader have no supplied AbortSignal. Thus cancellation stops client
display/consumption; it does **not guarantee remote generation stops or
credits/quotas are refunded**. Errors after response headers can appear as a
broken stream rather than a new HTTP error response.

## Customer prerequisite, not a bundled provider

The intended Windows PowerShell command is exactly one invocation:

```powershell
irm https://raw.githubusercontent.com/saketlunker/githubRelay/main/web-install.ps1 | iex
```

The public URL returned 200 as static data. Its LF SHA-256 was
`27b2bce6ae3a1345ff7c47ec8c2e2d6e42a35226c00136accacd81a02ee7ca38`,
matching this source pin after newline normalization. It was not executed.
The URL follows mutable `main`; it is not a version-pinned installer.

The public GitHub release
<https://github.com/saketlunker/githubRelay/releases/tag/npm-v0.3.1>
was independently visible without authentication, not a draft or prerelease.
Its `githubrelay-0.3.1.tgz` asset was 115370 bytes with API-reported SHA-256
`d58ad03c245cb83859a8b1cf9fb55fb5752d58eeb9e384d2916b11161c0294e7`.
A direct npm metadata request failed TLS on the qualification PC; npm
publication and clean-machine installation were not independently proved.

Prerequisites: Windows 10/11, PowerShell 5.1+, Node 22.13.0+ with npm, a GitHub
account with an active Copilot subscription, and permitted network/service
access. No VS Code or Copilot CLI installation is required. The script tries
winget Node LTS installation if needed; winget availability and installation
permissions are not guaranteed. Otherwise it requires manual Node installation
and reopening PowerShell. The npm `&&` one-liner requires PowerShell 7;
Windows PowerShell 5.1 users need separate commands or the `irm` command above.

GitHub release fallback acquires the launcher only. Gateway setup still uses
`npm ci` for its locked dependency closure. A fresh machine therefore needs
working dependency registry access or a complete existing cache; do not claim
offline or universally registry-blocked installation.

`githubrelay setup` installs the gateway, starts external GitHub device
sign-in, starts the service, configures installed coding-agent defaults, and
creates a re-link shortcut and a sign-in update task. The installed gateway
also registers logon and watchdog tasks. Existing installs use
`githubrelay auth` for sign-in and `githubrelay start` to start; authentication
can stop/restart an existing gateway. These are user actions, never automatic
Wispling health/connection actions. The headless background process must stay
running; a visible app window need not remain open.

Relay's existing npm launcher runs its management/authentication PowerShell
child with process-scoped `-ExecutionPolicy Bypass`
(`packages\npm\lib\environment.mjs:99,137`). It does not thereby change the
stored machine execution policy, and managed policy can still block it.
This is a property of the separate Relay prerequisite, not a recommendation
for a Wispling installer to copy or execute that flag. Do not describe the
entire prerequisite chain as execution-policy-workaround-free.

No successful model entitlement, quota, identity-policy acceptance, fresh
login, signing qualification, or end-to-end beta smoke is implied by these
checks. Present the observed boundary, not a promise that every Copilot
account/model works. Keep a non-model pet mode usable when the prerequisite
or account is unavailable.

## Source map and offline samples

Line numbers below refer to the pinned sources, before this documentation:

| Contract | Source |
| --- | --- |
| Paths/defaults/key creation | `powershell\CopilotHarnessGateway.psm1:8-45,368-476` |
| Registry dependency install | `powershell\CopilotHarnessGateway.psm1:586-685` |
| Health/deep check | `powershell\CopilotHarnessGateway.psm1:1072-1097` |
| Device login/user env handoff | `powershell\CopilotHarnessGateway.psm1:1500-1545,1708-1772` |
| Auth precedence/routes/Origin | `runtime\lib\supervisor-core.mjs:48-90` |
| Health/error/proxy/cancellation | `runtime\supervisor.mjs:437-458,533-583,714-834` |
| Setup side effects/updater | `packages\npm\bin\githubrelay.js:70-123,146-197` |
| Launcher payload / execution policy | `scripts\build-npm-payload.mjs:3-20`, `packages\npm\lib\environment.mjs:87-105,125-138` |
| Public model shape | Backend `src\routes\models\route.ts:40-56,146-169,508-536` |
| Model fields/normalization/mapping | Backend `src\lib\types\models.ts:1-55`, `src\lib\models.ts:11-16`, `src\lib\model-policy.ts:124-126` |
| Chat request/SSE | Backend `src\routes\chat-completions\handler.ts:27-145`, `src\lib\types\chat-completions.ts:1-199` |
| Response header timing | Backend `src\start.ts:6,192-198`, `src\services\copilot\create-chat-completions.ts:65-79`, `src\routes\chat-completions\handler.ts:83-120`; Relay `runtime\supervisor.mjs:790-806` |
| Locked stream implementation | `srvx@0.11.22` `dist\adapters\node.mjs:49-56,99-124`; `hono@4.13.1` `dist\helper\streaming\sse.js:47-63`; `fetch-event-stream@0.1.6` `esm\mod.js:35-68` |
| Upstream errors/cancellation | Backend `src\lib\error.ts:15-59`, `src\services\copilot\create-chat-completions.ts:22-97` |

The original, credential-free vectors in
`tests\fixtures\external-relay-protocol.json` include a catalog with unsupported
and additional-provider entries, normal/limited/filtered/tool/partial streams,
UTF-8 and SSE framing cases, and both error envelope types. They are test
inputs, not copied backend implementation and not live model evidence. Run
`node --test tests\node\external-relay-contract.test.mjs` offline to validate
the vectors and the shared public-route/auth helpers. Consumers must also run
these vectors against their own native client; fixture validation alone is
not provider qualification.
