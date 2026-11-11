# FortiPi portable client

A browser/Node SDK for the public FortiPi protocol. It imports the published
contract, uses native fetch/WebSocket, and owns its fixed Ajv 2020-12 validators.
The browser entry has no Node imports or import-time runtime/credential checks.

```ts
import { FortiPiClient } from "fortipi-client/browser"; // or fortipi-client/node

const client = new FortiPiClient({
  endpoint: "https://agent.example",
  credentials: async ({ endpoint, signal, reason }) =>
    acquireApplicationCredential(endpoint, signal, reason),
});
await client.negotiate();
const agents = await client.agents.list({ limit: 20 }, { signal });
const conversation = await client.conversations.create(agents.items[0].agentId, {
  requestId: crypto.randomUUID(),
  title: "Investigation",
});
const stream = client.conversations.subscribe(conversation.conversationId, {
  signal,
  onSnapshot: async (snapshot) => replaceProjection(snapshot),
  onEvent: async (event) => applyInOrder(event),
});
await stream.ready;
const intent = client.messageIntent(conversation.conversationId, "Inspect the workspace");
const receipt = await intent.send({ signal });
// An uncertain response can retry intent.send() with the SAME body and key.
stream.close();
await stream.done;
```

Application functions in this example are supplied by the consumer. Resource
methods accept canonical generated DTOs and an optional `{ signal }`; paginated
lists expose `nextPageToken`, passed back as `pageToken`. Busy rejection is never
silently changed into steering. An admission receipt records admission, and does
not prove assistant/task/workspace completion.

| Surface         | Methods                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------ |
| `discovery`     | health, protocol, openApi, schema (allowlisted filenames)                                        |
| `agents`        | list, get                                                                                        |
| `conversations` | list, create, get, send, steer, fork, events, subscribe                                          |
| `tasks`         | get, cancel, resume                                                                              |
| `approvals`     | get, decide (exact digest and expected version)                                                  |
| `jobs`          | get, reconcile (explicit evidence/action/reason/version)                                         |
| `executors`     | list (redacted ordinary-client metadata)                                                         |
| `workspaces`    | list, create, get, rebind, manifest, files, stat, read, diff, snapshot, blob, artifact, transact |
| `uploads`       | begin, get, abort, chunk, validate, commit, receipt                                              |
| `tickets`       | mint (fresh scoped client-stream ticket)                                                         |
| `artifacts`     | read, stream (bounded, verified bytes from the exact descriptor route/revision)                  |

`client.operations` supplies every generated canonical operation ID directly, with
generated path/query/body input and success value types. Administrative/executor
operations require their own explicit credentials and grants; the TUI uses only
ordinary application resources. The two upgrade operations return a native socket
and `close()` handle, leaving frame handling to the low-level caller. Prefer
`conversations.subscribe` for validated replay and live client events. A ticket
is consumed by a single upgrade attempt, including failed attempts.

`client.request({operationId,path,query,body}, options)` preserves the generated
HTTP status union. HTTP application errors throw `FortiPiError` with code,
requestId, status, retryability and typed details. Errors omit remote messages,
raw requests/responses, transport causes and ticket URLs. `client.execute` returns
the success body. Upgrade operations use `operations`, rather than HTTP request.

The endpoint must be an HTTPS origin without userinfo/query/fragment/path.
Unencrypted localhost/127.0.0.1/[::1] requires `allowLoopbackHttp: true`. Redirects
are rejected, fetch omits cookies, bearer acquisition is asynchronous/cancellable,
and authorization never follows foreign descriptors or redirects. Browser tickets
bind the actual platform Origin; Node defaults to explicit native/no-Origin mode.
The server's configured CORS/Origin allowlist still applies. Fetch and WebSocket
factories can be injected; they must honor the public interface. One 401 may
reacquire credentials; forbidden/revoked sessions pause. No refresh endpoint or
provider/deployment token belongs in a client.

Protocol/schema/features and effective infrastructure limits are checked before
mutation or subscription. Remote schema documents are never compiled. Known
frames are closed and strictly validated; valid unknown durable events are applied
generically. Byte reads require the declared response length/hash, validate range
coordinates, and report interrupted/truncated streams as failures. `artifacts.stream`
verifies bounded bytes before yielding 64 KiB pieces; it intentionally buffers at
most the effective bounded response limit for native WebCrypto SHA-256.

A subscription serializes asynchronous decoding/application, bounds its queue,
deduplicates committed IDs (checking older identities with bounded stored-event
lookups), and repairs gaps through paginated stored events before
a fresh ticket subscription/high-water barrier. Only successful durable application
advances its cursor. Deltas, receipts and heartbeat never advance it. Handler
failure pauses with the previous cursor. Expired cursors resnapshot; invalid/future
cursors require explicit resnapshot by the caller. Close/abort disposes listeners,
sockets and backoff timers. Retries are bounded and observe finite retry hints;
storage pressure requires reclamation/configuration instead of repeated ticketing.
No account-wide headroom or model-provider usage budget is inferred.

Ticket identity comes only from authenticated minting. `onIdentity` receives the
redacted identity, and `subscription.scope` binds its origin/conversation/deployment/
principal/role/credential ID/generation/grantVersion. Supplying `after` requires
the matching `scope` retained from that subscription and its applied projection.
A changed authority scope resnapshots; a fresh ticket TTL does not change scope.
After process restart, rebuild from an authoritative snapshot. Persisted
projection and cursor must be saved together; optional `onCursor` is the matching
persistence hook after application. Snapshot handlers must replace both together.
A callback must complete successfully only when its application has succeeded.
Persist the scope alongside them. Never infer identity by decoding an opaque bearer.
Credential issuance operations preserve `issued` versus `already-issued`; matching
retries cannot recover lost one-time token material or silently mint a replacement.

Verification uses actual package exports, strict public declarations, a browser
bundle excluding Node builtins, real HTTP redirect checks, and controlled ordering/
quota fixtures. The TUI suite additionally exercises native HTTP/WebSocket against
an in-memory service fixture. These prove client behavior for exercised inputs;
Worker durability, real browser CORS/revocation, installed packs and deployed
interoperability remain parent/owner10 acceptance requirements.
