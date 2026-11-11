# Security and credentials

ControlPlane is a plain SQLite Durable Object, addressed only as
`CONTROL_PLANE.getByName("control")`. Workspace authorities use
`WORKSPACES.getByName(workspaceId)`. Public IDs are identifiers, not authority.
The Worker constructs authenticated RPC contexts and strips incoming internal
authority headers. `contractVersion` is a prototype getter returning `"1.0"`;
callers await the property on the actual platform stub.

## Application authority

Application admin, client and executor tokens are independent random 256-bit
credentials. Durable application rows contain SHA-256 verifiers, IDs, roles,
grants, expiry and generations; no retrievable application token. Verification
compares fixed-length digests with `timingSafeEqual`, including an unknown-ID
dummy comparison. Admin routes require the admin audience plus explicit grants.
Role alone grants no conversation or tool access. Executors cannot acquire a
client stream or use application/administration operations.

Delegation checks every resource/action/tool/target and expiry against the
issuer. Rotation publishes replacement issuance and old-identity invalidation
in one SQLite transaction. Issuance material is returned once. An operator must
keep an independently usable administrator when rotating its own credential.
Never log credential responses, authorization headers, provider responses or
complete request URLs. Audit records contain only bounded IDs, actions and
decisions. Authentication, status polling and executor heartbeats write no
last-used/audit rows.

`FORTIPI_ADMIN_TOKEN` is the application bootstrap, not a deployment or model
credential. Its fingerprint resolves to the same durable identity on redeploy.
Its revocation tombstone survives re-uploading that same secret. CI retains only
this application bootstrap. Trusted evidence issues short-lived, explicitly
scoped application/executor credentials and revokes them in cleanup. Pending
revocation is incomplete cleanup. Runtime receives no Cloudflare deployment or
npm publication credentials.

## Tickets and sockets

Tickets are opaque, hash-only, audience/resource/Origin-bound and one-use. The
default lifetime is 30 seconds, with a 60-second ceiling. Expiry equality rejects.
Ticket authentication needs no existing bearer. Consumption and destination
registration share one transaction, before upgrade. Failed upgrades spend their
ticket. A browser Origin must match the mint request's validated Origin; native
mode omits Origin. The Worker checks same-origin or its explicit HTTPS allowlist
before supplying `CredentialProof.origin`. Preflight is unauthenticated and
bounded; there is no wildcard credential CORS. Proxies must redact ticket query
strings from access/error logs.

An executor's application credential generation, execution generation and socket
connection epoch are separate. Reconnect increments only the epoch. Restoring a
lost execution ledger requires explicit new-generation authorization. The
platform owns WebSockets and hibernation; there is no Agents socket protocol or
second scheduler. Attachments contain nonsecret identity/scope/epoch metadata.
The negotiated heartbeat frame contains dynamic identity/time fields, so the
handler uses volatile liveness instead of inventing a static auto-response.
Heartbeat eligibility ends after 45 seconds. A coalesced alarm records semantic
offline transitions; observed offline notification may be later. On a wake with
no recent volatile liveness, routing conservatively waits for a fresh heartbeat.

## Dispatch, local files and delivery

ControlPlane persists target reservations and all agent/workspace recipients
before issuing authority for lease acquisition. It validates canonical operation
and assignment identities, stores dispatch intent, then durably claims the
first send before calling `socket.send`. Concurrent duplicates observe that
claim. Lost acknowledgments, disconnects and restart permit query of the same
execution, never another assign or a target switch. Cancellation retries retain
one identity and report actual disposition/possible external effects.

Public writers use explicit acquire, renew and release lease routes under
`workspace.write`. Their durable business request binds its body and the first
derived private input before authority RPC. Lost acknowledgments reuse that
input and actual returned receipt, including chosen expiry and fence. Computer
holders name the logical workspace/version; private records retain target kind
so an unrelated executor ID cannot become its revocation subject. Public release
returns only leaseId/released and retains the private tombstone proof internally.
A pending release closes authority locally before RPC. Renewal uses the original
operation deadline and current credential/grant expiry, independently of the
first-acquisition admission cutoff. There is no automatic renewal scheduler.

Executor frames are validated against fixed trusted schemas compiled at module
activation. Sender credential, execution generation, connection epoch and the
stored assignment are checked before durable acceptance. Bounded output/results
are deduplicated by execution/type/sequence and payload digest. A transport ack
means receipt, not workspace publication or Pi success. Receiver acknowledgments
must match the original durable delivery ID/sequence. Source facts retain stable
IDs until the receiving agent returns its actual persisted event ID/sequence;
ControlPlane never invents a replay coordinate. Late prepared results can be
quarantined for authorized reconciliation without replacing an accepted outcome.

Local operations use prepare → authority intent → one claimed apply → observe →
metadata commit → receipt delivery. Only the returned preparation and authority
intent authorize apply. A missing apply acknowledgment resumes observe. Receipt
delivery verifies the actual authority receipt and retries only that receipt.
Observe and receipt recovery can use a historical lease under current read
authority; they cannot initiate new filesystem effects. The native daemon owns
root pins, local policy and its journal. Remote approval does not broaden that
policy or provide OS confinement. Local import must establish a retained,
explicitly approved revision before any retained snapshot is available.
An explicit successful local lease renewal forwards only the stored preparation
with the actual renewed lease. The same preparation and original authority intent
must be acknowledged; renewal cannot repeat apply or change staged metadata.

Local bytes use two simultaneously active HTTP requests. The executor routes are
`/v1/executor/transfers/{transferId}/input/chunks/{chunkIndex}` (GET),
`.../output/chunks/{chunkIndex}` (PUT), and
`/v1/executor/transfers/{transferId}` (GET status). Each includes `attemptId`;
chunks also bind declared length and SHA-256. The service forwards the other peer
to `/internal/transfers/{transferId}/peer/chunks/{chunkIndex}` with an authenticated
`X-Fortipi-Context` envelope, after stripping that header from public requests.
This envelope is private Worker-to-DO transport, never a public credential.

A local read first returns metadata without starting a producer. ControlPlane
requires the owner's actual chunk inventory, then matches its grid, hashes,
file size and retained manifest membership before opening a descriptor. The same
operation with that exact descriptor starts the producer. Chunk grids are
negotiated integers up to 256 KiB, with at most 256 hashes; empty files use an
empty inventory and have no chunk PUT. Neither a different grid nor an
interrupted descriptor can authorize a producer. Metadata and local RPC bodies
are bounded before durable admission.
The executor registers five validated numeric transfer bounds. Keyed generation
resolution returns null when no current-generation observation exists. Every
transfer opening and byte operation rechecks current bounds; registration does
not promise remaining space, online availability or a future configuration.

The relay verifies one transient chunk buffer before exposure, honors consumer
backpressure and requires independent recipient hash verification. Limits are
256 KiB/chunk, two matched chunks/transfer, four/install or lower configured
policy; rendezvous/idle 10 seconds, chunk total 30 seconds and descriptor lifetime
at most 60 seconds and within lease/deadline. Revoke and delivered abort events
interrupt the entire attempt. Restart requires a new attempt. Completed PUT repeats only its recorded chunk receipt; completed
GET requires a new authorized attempt because vanished RAM cannot replay bytes.
No local bytes enter SQLite, R2, Computer, WebSocket JSON, logs or facts.

The local Wrangler proxy did not propagate an unmatched GET disconnect within
500 ms, including with explicit signal forwarding and the documented
`enable_request_signal`/`request_signal_passthrough` flags. Actual HTTP tests
prove settlement by the ten-second rendezvous deadline; they do not prove
immediate disconnect cleanup. Deployment configuration and forwarding must
preserve incoming signals; [Cloudflare's compatibility rules](https://developers.cloudflare.com/workers/configuration/compatibility-flags/)
describe both flags. Managed integration and deployed cancellation remain
separate evidence requirements.

## Revocation and infrastructure pressure

The first revocation transaction changes durable status/generation before
fanout. Registration either precedes that transaction and enters its immutable
cutoff or is denied. Credential and executor subjects are distinct. Registered
recipient records/floors are retained after reservation release. Fanout pages are
bounded and acknowledgments must match subject, recipient, revocation ID and a
persisted minimum floor. A closed socket, successful send, timeout or unreachable
recipient cannot complete revocation. Empty-recipient completion is valid.

One existing alarm drains due work in bounded turns. Delivery/backoff state is
durable, retries are idempotent, and attempted assign is never a drain action.
No cross-DO instantaneous revocation or recall of in-flight network bytes is
promised. AgentSession and WorkspaceObject must order their own persisted floors
with attach/lease/result/commit and check expiry on outbound subscription delivery.

Capacity reservations retain identity across retry/restart and count outstanding
claims pessimistically. A failed/uncertain write does not release capacity.
Settlement requires measured bytes under internal authority and is idempotent;
consumed bytes remain charged. Physical SQLite size and reserved usage preserve
completion/revoke/repair headroom. Existing history/receipts are not evicted to
admit new work. Unknown/free defaults are conservative; paid account status alone
does not raise bounds or provision Loader/Containers. Account-wide remaining
capacity is unknown without authoritative telemetry. There is no quota poller,
deployment credential in runtime, or model-provider token/hour/week budget.
Request-rate admission uses bounded volatile per-incarnation minute windows;
durable reservation accounting survives process death. Health and usage expose
actual outstanding slot/storage claims and overdue repair work, without a
shared-account remaining-capacity assertion.
Application admission preserves the configured fraction for repair attempts.
The alarm has both a per-turn and per-minute repair bound; an exhausted local
window persists its next eligible minute and rearms there, preserving pending
work instead of repeatedly waking against an exhausted window.
Validated recipient quota refusals retain pressure and their actual known reset,
retry time and retry-after advice. Durable per-row eligibility prevents duplicate
wakes from advancing a retry. Storage refusal has no invented reset and removes
the task's timed due date until confirmed reclamation or a new configuration
permits repair. Matching configuration/settlement retries do not clear that hold.
These are local policy/receiver observations, not account-wide quota telemetry.

## Provider authentication

Workers AI remains a separate binding. Standard API keys use configured server
secretRefs. OAuth supports OpenAI ChatGPT (`openai`), Anthropic (`anthropic`) and
the distinct OAuth-only Codex provider (`openai-codex`). CLI interactive login
uses public Pi Models with an in-memory store; it never harvests ambient Pi auth
files. ControlPlane imports narrow public Models/provider exports and installs
Worker-safe refresh/toAuth adapters, leaving Node callback-server login in CLI.

GET/PUT/DELETE `/v1/admin/models/{providerId}/auth` require their explicit
`models.auth.status/write/delete` grants. PUT is write-only and versioned, with
at most 64 KiB encoded canonical body and 16 KiB each for access/refresh strings.
The registry bounds provider fields and preserves OpenAI issued clientId/scopes
and Codex account binding. Status, tombstones and mutation receipts contain no
credential. Public export/backup must exclude provider-auth rows.

The dedicated optional `FORTIPI_MODEL_AUTH_KEY` is a preserved independent
256-bit AES-GCM key (64 hex digits or standard base64). Missing/wrong key denies
OAuth; bootstrap rotation never derives or replaces it. Each ciphertext has a
fresh 96-bit nonce and AAD binding deployment/provider/format/key ID/generation/
version. Complete credentials exist in plaintext only transiently during trusted
resolution. Each provider has its own promise chain covering the entire async
modifier and durable publication. Undefined from Pi `modify` means unchanged;
only delete removes the credential. Ingest/logout share that chain and publish
their idempotency receipt in the ciphertext transaction. Generation/version CAS
and a final caller check prevent stale publication after logout/revocation.

A durable refresh-intent marker precedes token exchange. Caller cancellation
does not release an active refresh's store lock or discard its persisted result.
An orphaned/failed exchange requires reauthentication instead of blindly retrying
a possibly consumed rotating refresh token. Fixed HTTPS token endpoints use a
real Worker Request with manual redirects and reject every 3xx, bound responses
and sanitize errors. Private resolution returns only
request auth for the configured model factory. No public credential retrieval,
ambient file lookup, provider agent loop or universal OAuth compatibility claim
exists. Synthetic refresh tests do not establish a live provider subscription.

Refresh protocol adaptation follows the pinned Pi AI 1.5.2 OpenAI ChatGPT,
Anthropic and Codex OAuth implementations, Copyright (c) 2025 Mario Zechner,
[MIT](https://github.com/earendil-works/pi/blob/v1.5.2/LICENSE). Distribution must
retain the complete upstream MIT notice supplied by the repository license gate.

## Reproducible evidence and limits

Run from the worktree with the canonical Node26.13.0/pnpm12.18.0 toolchain first:

```sh
node packages/fortipi-contract/scripts/generate.ts --check
pnpm exec tsc -p packages/fortipi-contract/tsconfig.json
pnpm exec tsc -p apps/worker/tsconfig.json --noEmit
pnpm exec tsc -p tsconfig.tools.json --noEmit
node --test apps/worker/test/control/*.test.ts
node apps/worker/test/control/sensitivity.ts
```

| Requirement oracle                                                | Actual local observation                                                                                                                                                                                                       | Sensitivity / limit                                                                                                                                            |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One ticket has one consumed identity/registration                 | Concurrent ticket-only redemption admits one; audience/Origin/destination/expiry/spent retry reject                                                                                                                            | Disposable removal of consumption fails the independent single-redemption assertion; restored copy passes                                                      |
| Revoke cannot complete before every matching floor acknowledgment | Real recipient storage writes a floor, drops its ack; CP denies immediately and stays pending, then completes after matching retry                                                                                             | Disposable premature-completion mutation fails the pending assertion; restored copy passes. Recipient fixtures prove CP orchestration, not sibling enforcement |
| Attempts cannot turn ambiguity into another assign                | Actual WebSocket registration/heartbeat and concurrent assign; one assign frame, then query/unknown and no second assign                                                                                                       | Frame counts are transport evidence, not native process-start proof                                                                                            |
| Semantic facts repair a lost acknowledgment                       | Persisted recipient event coordinates survive dropped ack; retry retains source identity and appends no second event                                                                                                           | Controlled SQLite/KV recipient fixture; actual AgentSession event projection remains integration evidence                                                      |
| Capacity cannot over-admit or partially acknowledge               | Competing final-slot requests, exact settlement and actual SQLite trigger refusal mid-transaction                                                                                                                              | Trigger abort substitutes storage refusal, not Cloudflare account exhaustion                                                                                   |
| Local bytes need a live peer and verified content                 | Two real HTTP requests rendezvous; independent Node SHA-256 matches delivered bytes; unmatched producer is not acked; completed GET cannot replay                                                                              | Local HTTP fixture explicitly forwards synthetic HTTPS internally; production TLS, real local daemon and network disconnect matrix remain integration gates    |
| OAuth persistence precedes resolution and survives process death  | Actual workerd Models.getAuth and all three adapters use synthetic token transports; serialized refresh/CAS, key/AAD/tamper rejection; abrupt Wrangler/workerd kill/reopen decrypts complete credential with no second refresh | Synthetic credentials/transport; no external account, live provider or deployment claim                                                                        |
| Bootstrap and reservations survive abrupt restart                 | Real `wrangler dev --local --persist-to` process tree is killed, same config/object/state reopens with committed canary, same reservation and revoked bootstrap                                                                | A local process restart is not deployed platform eviction; createTestHarness reset is not used as persistence proof                                            |

The canonical phase3 thread-4 build report records final revision, exact commands,
all-file hook failures/skips and remaining blockers. Release still requires real
AgentSession/Workspace floors and application replay, native executor start/local
policy/import evidence, browser/public-client transport, selected Cloudflare
capabilities and deployed release verification. No test count or green mock
substitutes for those observations.
